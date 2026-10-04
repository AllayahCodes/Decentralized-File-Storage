# Decentralized File Storage

A Solidity smart contract that manages decentralized file storage using **IPFS** for the files and **Ethereum** for metadata, access control and payments.

Only the IPFS content identifier (CID) and metadata are stored on-chain. The files themselves never touch the blockchain.

## How it works

1. A user uploads a file to IPFS and receives a CID.
2. The user deposits ETH into the contract (`addFunds`).
3. The user registers the file (`uploadFile`) with its CID, size and storage duration. The cost (`size × days × price per byte per day`) is deducted from their deposit.
4. The owner can grant or revoke access to other addresses, renew storage, or remove the file.
5. Revenue is forwarded to a `treasury` address, which can be an OpenZeppelin `PaymentSplitter` (v4) so earnings are shared between payees.

## Features

- **Metadata on-chain:** CID, owner, size, upload time, status and expiry stored in a struct.
- **Access control:** owners grant and revoke per-file access. Access ends automatically when a file expires or is removed.
- **Pay-per-byte pricing:** configurable price, with minimum and maximum file sizes and storage durations.
- **Renewable storage:** extend a file's period. Renewing an expired file restarts from the current time, and total duration is capped.
- **Safe accounting:** user deposits and earned revenue are tracked separately. Admin withdrawals can only move earned revenue, never user deposits. Users can withdraw their unspent balance at any time.
- **Roles:** `ADMIN_ROLE` manages pricing, treasury, pausing and revenue. `OPERATOR_ROLE` can remove files for moderation.
- **Emergency pause:** blocks deposits, uploads, renewals and new access grants. Users can still withdraw their balance, revoke access and remove files.
- **Events** for every state change.
- Built with OpenZeppelin `AccessControl`, `ReentrancyGuard` and `Pausable`.

## Tech stack

- Solidity `^0.8.25` (compiled with 0.8.28)
- Hardhat 2 with the Hardhat Toolbox (ethers v6, Chai, Mocha)
- OpenZeppelin Contracts 5

## Getting started

```bash
npm install
npx hardhat compile
npx hardhat test
```

Optional gas report:

```bash
npm run gas
```

Deploy to the in-process Hardhat network (also uploads a sample file):

```bash
npm run deploy-local
```

Deploy to a local node:

```bash
npm run node      # terminal 1
npm run deploy    # terminal 2
```

The deploy script reads optional environment variables: `TREASURY_ADDRESS`, `PRICE_PER_BYTE_PER_DAY` (wei) and `OPERATOR_ADDRESS`.

## Tests

55 tests covering deployment, funds, upload limits, access control, renewal and expiry, removal, revenue, admin functions and pausing.

```
55 passing
```

Time-dependent behaviour (expiry, renewal after expiry) is tested with Hardhat's `time` helpers rather than the system clock.

## Project structure

```
contracts/DecentralizedStorage.sol   Main contract
test/DecentralizedStorage.test.js    Test suite
scripts/deploy.js                    Deployment script
hardhat.config.js                    Hardhat configuration
```

## Known limitations

- **File size is self-reported.** The contract can't verify the size of a file stored on IPFS, so users can under-report to pay less. A production system would need an oracle or off-chain verification.
- **On-chain access control does not protect IPFS content.** CIDs are visible in transaction data and events, and anyone with a CID can fetch the file from IPFS. For real privacy, encrypt files before upload and share keys with authorised users.
- **Expiry is not enforced on IPFS.** The contract stops granting access to expired files, but unpinning the data from IPFS must be handled off-chain.
- Not audited. Do not use with real funds without a professional security review.

## License

MIT
