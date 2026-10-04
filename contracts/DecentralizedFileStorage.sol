// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

// Targets OpenZeppelin Contracts v5 (what Remix fetches by default).
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title DecentralizedStorage
 * @dev Manages metadata, access control and payments for files stored on IPFS.
 *      Only the IPFS CID and metadata live on-chain, never the file itself.
 *      Revenue is forwarded to `treasury`, which can be an OpenZeppelin
 *      PaymentSplitter so earnings are split between payees.
 */
contract DecentralizedStorage is AccessControl, ReentrancyGuard, Pausable {
    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------
    enum FileStatus { Active, Removed }

    struct FileMetadata {
        string ipfsHash;         // IPFS content identifier (CID)
        address owner;           // File owner
        uint256 fileSize;        // Size in bytes
        uint256 uploadTimestamp; // Upload time
        FileStatus status;       // Current status
        uint256 expirationTime;  // When the paid storage period ends
    }

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------
    uint256 public pricePerBytePerDay; // wei per byte per day
    uint256 public minimumStorageDays;
    uint256 public maximumStorageDays;
    uint256 public minimumFileSize;
    uint256 public maximumFileSize;

    uint256 private _nextFileId;
    mapping(uint256 => FileMetadata) private _files;
    mapping(uint256 => mapping(address => bool)) private _accessList; // fileId => user => allowed
    mapping(address => uint256[]) private _userFiles;

    mapping(address => uint256) public userBalances; // unspent user deposits
    uint256 public pendingRevenue;                   // earned, not yet sent to treasury
    uint256 public totalRevenue;                     // lifetime earned
    address payable public treasury;                 // e.g. a PaymentSplitter

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event FileUploaded(
        uint256 indexed fileId,
        address indexed owner,
        string ipfsHash,
        uint256 fileSize,
        uint256 expirationTime
    );
    event FileRemoved(uint256 indexed fileId, address indexed removedBy);
    event AccessGranted(uint256 indexed fileId, address indexed grantedTo, address indexed grantedBy);
    event AccessRevoked(uint256 indexed fileId, address indexed revokedFrom, address indexed revokedBy);
    event PaymentReceived(address indexed user, uint256 amount, uint256 newBalance);
    event BalanceWithdrawn(address indexed user, uint256 amount);
    event StorageRenewed(uint256 indexed fileId, uint256 newExpirationTime, uint256 paymentAmount);
    event RevenueWithdrawn(address indexed treasury, uint256 amount);
    event PriceUpdated(uint256 newPricePerBytePerDay);
    event TreasuryUpdated(address indexed newTreasury);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------
    modifier fileExists(uint256 _fileId) {
        require(_files[_fileId].owner != address(0), "File does not exist");
        _;
    }

    modifier onlyFileOwner(uint256 _fileId) {
        require(_files[_fileId].owner == msg.sender, "Not file owner");
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------
    /**
     * @param _treasury Address that receives revenue (deploy a PaymentSplitter and pass it here)
     * @param _initialPricePerBytePerDay Initial price per byte per day in wei
     */
    constructor(address payable _treasury, uint256 _initialPricePerBytePerDay) {
        require(_treasury != address(0), "Treasury address cannot be zero");

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);

        treasury = _treasury;
        pricePerBytePerDay = _initialPricePerBytePerDay;
        minimumStorageDays = 30;
        maximumStorageDays = 365;
        minimumFileSize = 1;
        maximumFileSize = 10 * 1024 * 1024; // 10 MB
    }

    // ---------------------------------------------------------------------
    // Payments
    // ---------------------------------------------------------------------
    /// @dev Deposit funds to pay for storage.
    function addFunds() external payable whenNotPaused nonReentrant {
        require(msg.value > 0, "Amount must be greater than zero");
        userBalances[msg.sender] += msg.value;
        emit PaymentReceived(msg.sender, msg.value, userBalances[msg.sender]);
    }

    /// @dev Withdraw your own unspent balance.
    function withdrawBalance(uint256 _amount) external nonReentrant {
        require(_amount > 0, "Amount must be greater than zero");
        require(userBalances[msg.sender] >= _amount, "Insufficient balance");

        userBalances[msg.sender] -= _amount;

        (bool success, ) = payable(msg.sender).call{value: _amount}("");
        require(success, "Transfer failed");

        emit BalanceWithdrawn(msg.sender, _amount);
    }

    /// @dev Send earned revenue (never user deposits) to the treasury.
    function withdrawRevenue() external onlyRole(ADMIN_ROLE) nonReentrant {
        uint256 amount = pendingRevenue;
        require(amount > 0, "No revenue to withdraw");

        pendingRevenue = 0;

        (bool success, ) = treasury.call{value: amount}("");
        require(success, "Transfer failed");

        emit RevenueWithdrawn(treasury, amount);
    }

    /// @dev Plain ETH transfers are rejected so funds can't get stuck unaccounted.
    receive() external payable {
        revert("Use addFunds()");
    }

    function _charge(address _user, uint256 _fileSize, uint256 _days) internal returns (uint256 cost) {
        cost = calculateStorageCost(_fileSize, _days);
        require(userBalances[_user] >= cost, "Insufficient balance");

        userBalances[_user] -= cost;
        pendingRevenue += cost;
        totalRevenue += cost;
    }

    // ---------------------------------------------------------------------
    // File management
    // ---------------------------------------------------------------------
    /**
     * @dev Register a file already uploaded to IPFS.
     * @param _ipfsHash IPFS CID
     * @param _fileSize Size in bytes
     * @param _storageDays Number of days to store the file
     */
    function uploadFile(
        string calldata _ipfsHash,
        uint256 _fileSize,
        uint256 _storageDays
    ) external whenNotPaused nonReentrant returns (uint256 fileId) {
        require(bytes(_ipfsHash).length > 0, "IPFS hash cannot be empty");
        require(_fileSize >= minimumFileSize, "File size below minimum");
        require(_fileSize <= maximumFileSize, "File size exceeds maximum");
        require(_storageDays >= minimumStorageDays, "Storage duration below minimum");
        require(_storageDays <= maximumStorageDays, "Storage duration exceeds maximum");

        _charge(msg.sender, _fileSize, _storageDays);

        fileId = _nextFileId;
        _nextFileId++;

        uint256 expiration = block.timestamp + (_storageDays * 1 days);

        _files[fileId] = FileMetadata({
            ipfsHash: _ipfsHash,
            owner: msg.sender,
            fileSize: _fileSize,
            uploadTimestamp: block.timestamp,
            status: FileStatus.Active,
            expirationTime: expiration
        });

        _accessList[fileId][msg.sender] = true; // owner always has access
        _userFiles[msg.sender].push(fileId);

        emit FileUploaded(fileId, msg.sender, _ipfsHash, _fileSize, expiration);
    }

    /// @dev Owner, or an operator (moderation), can remove a file.
    function removeFile(uint256 _fileId) external fileExists(_fileId) {
        FileMetadata storage file = _files[_fileId];
        require(
            file.owner == msg.sender || hasRole(OPERATOR_ROLE, msg.sender),
            "Not owner or operator"
        );
        require(file.status == FileStatus.Active, "File already removed");

        file.status = FileStatus.Removed;
        emit FileRemoved(_fileId, msg.sender);
    }

    /**
     * @dev Extend storage. If the file has already expired, the new period
     *      starts from now; otherwise it is added to the current expiry.
     */
    function renewStorage(uint256 _fileId, uint256 _additionalDays)
        external
        whenNotPaused
        nonReentrant
        fileExists(_fileId)
        onlyFileOwner(_fileId)
    {
        FileMetadata storage file = _files[_fileId];
        require(file.status == FileStatus.Active, "File not active");
        require(_additionalDays > 0, "Must add at least one day");
        require(_additionalDays <= maximumStorageDays, "Renewal exceeds maximum");

        uint256 base = file.expirationTime > block.timestamp ? file.expirationTime : block.timestamp;
        uint256 newExpiration = base + (_additionalDays * 1 days);
        require(
            newExpiration - block.timestamp <= maximumStorageDays * 1 days,
            "Total duration exceeds maximum"
        );

        uint256 paid = _charge(msg.sender, file.fileSize, _additionalDays);
        file.expirationTime = newExpiration;

        emit StorageRenewed(_fileId, newExpiration, paid);
    }

    // ---------------------------------------------------------------------
    // Access control
    // ---------------------------------------------------------------------
    function grantAccess(uint256 _fileId, address _user)
        external
        whenNotPaused
        fileExists(_fileId)
        onlyFileOwner(_fileId)
    {
        require(_files[_fileId].status == FileStatus.Active, "File not active");
        require(_user != address(0), "Invalid address");
        require(!_accessList[_fileId][_user], "Access already granted");

        _accessList[_fileId][_user] = true;
        emit AccessGranted(_fileId, _user, msg.sender);
    }

    function revokeAccess(uint256 _fileId, address _user)
        external
        fileExists(_fileId)
        onlyFileOwner(_fileId)
    {
        require(_files[_fileId].status == FileStatus.Active, "File not active");
        require(_user != msg.sender, "Cannot revoke own access");
        require(_accessList[_fileId][_user], "No access to revoke");

        _accessList[_fileId][_user] = false;
        emit AccessRevoked(_fileId, _user, msg.sender);
    }

    /// @dev True only if the file is active, unexpired, and the user is on the list.
    function hasAccess(uint256 _fileId, address _user) public view returns (bool) {
        FileMetadata storage file = _files[_fileId];
        return
            file.owner != address(0) &&
            file.status == FileStatus.Active &&
            block.timestamp <= file.expirationTime &&
            _accessList[_fileId][_user];
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------
    /// @dev Owner can always read metadata (to renew); others need active access.
    function getFileMetadata(uint256 _fileId)
        external
        view
        fileExists(_fileId)
        returns (
            string memory ipfsHash,
            address owner,
            uint256 fileSize,
            uint256 uploadTimestamp,
            FileStatus status,
            uint256 expirationTime
        )
    {
        FileMetadata storage file = _files[_fileId];
        require(
            file.owner == msg.sender || hasAccess(_fileId, msg.sender),
            "No access to file"
        );

        return (
            file.ipfsHash,
            file.owner,
            file.fileSize,
            file.uploadTimestamp,
            file.status,
            file.expirationTime
        );
    }

    function getUserFiles() external view returns (uint256[] memory) {
        return _userFiles[msg.sender];
    }

    function calculateStorageCost(uint256 _fileSize, uint256 _days) public view returns (uint256) {
        return _fileSize * _days * pricePerBytePerDay;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------
    function updatePrice(uint256 _newPrice) external onlyRole(ADMIN_ROLE) {
        pricePerBytePerDay = _newPrice;
        emit PriceUpdated(_newPrice);
    }

    function updateTreasury(address payable _newTreasury) external onlyRole(ADMIN_ROLE) {
        require(_newTreasury != address(0), "Treasury address cannot be zero");
        treasury = _newTreasury;
        emit TreasuryUpdated(_newTreasury);
    }

    function grantOperator(address _operator) external onlyRole(ADMIN_ROLE) {
        _grantRole(OPERATOR_ROLE, _operator);
    }

    /// @dev Emergency stop: blocks deposits, uploads, renewals and new access grants.
    ///      Users can still withdraw their balance, revoke access and remove files.
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }
}
