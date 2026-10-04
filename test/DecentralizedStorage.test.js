const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const DAY = 86400n;
const PRICE = 1n; // wei per byte per day
const CID = "QmTestHash123";
const SIZE = 1000n;
const DAYS = 30n;
const COST = SIZE * DAYS * PRICE; // 30,000 wei
const DEPOSIT = 1_000_000n;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
async function deployFixture() {
  const [owner, treasury, operator, alice, bob, carol] = await ethers.getSigners();

  const Storage = await ethers.getContractFactory("DecentralizedStorage");
  const storage = await Storage.deploy(treasury.address, PRICE);
  await storage.waitForDeployment();

  await storage.grantOperator(operator.address);

  return { storage, Storage, owner, treasury, operator, alice, bob, carol };
}

async function fundedFixture() {
  const base = await deployFixture();
  await base.storage.connect(base.alice).addFunds({ value: DEPOSIT });
  return base;
}

async function uploadedFixture() {
  const base = await fundedFixture();
  await base.storage.connect(base.alice).uploadFile(CID, SIZE, DAYS);
  return base;
}

// ---------------------------------------------------------------------------
describe("DecentralizedStorage", function () {
  describe("Deployment", function () {
    it("Should grant admin roles to the deployer", async function () {
      const { storage, owner } = await loadFixture(deployFixture);
      expect(await storage.hasRole(await storage.DEFAULT_ADMIN_ROLE(), owner.address)).to.equal(true);
      expect(await storage.hasRole(await storage.ADMIN_ROLE(), owner.address)).to.equal(true);
    });

    it("Should set initial parameters", async function () {
      const { storage, treasury } = await loadFixture(deployFixture);
      expect(await storage.treasury()).to.equal(treasury.address);
      expect(await storage.pricePerBytePerDay()).to.equal(PRICE);
      expect(await storage.minimumStorageDays()).to.equal(30n);
      expect(await storage.maximumStorageDays()).to.equal(365n);
      expect(await storage.minimumFileSize()).to.equal(1n);
      expect(await storage.maximumFileSize()).to.equal(10n * 1024n * 1024n);
    });

    it("Should fail with a zero treasury address", async function () {
      const { Storage } = await loadFixture(deployFixture);
      await expect(Storage.deploy(ethers.ZeroAddress, PRICE)).to.be.revertedWith(
        "Treasury address cannot be zero"
      );
    });
  });

  describe("Funds", function () {
    it("Should credit deposits and emit PaymentReceived", async function () {
      const { storage, alice } = await loadFixture(deployFixture);
      await expect(storage.connect(alice).addFunds({ value: DEPOSIT }))
        .to.emit(storage, "PaymentReceived")
        .withArgs(alice.address, DEPOSIT, DEPOSIT);
      expect(await storage.userBalances(alice.address)).to.equal(DEPOSIT);
    });

    it("Should reject a zero deposit", async function () {
      const { storage, alice } = await loadFixture(deployFixture);
      await expect(storage.connect(alice).addFunds({ value: 0 })).to.be.revertedWith(
        "Amount must be greater than zero"
      );
    });

    it("Should reject plain ETH transfers", async function () {
      const { storage, alice } = await loadFixture(deployFixture);
      await expect(
        alice.sendTransaction({ to: await storage.getAddress(), value: 1n })
      ).to.be.revertedWith("Use addFunds()");
    });

    it("Should let users withdraw their unspent balance", async function () {
      const { storage, alice } = await loadFixture(fundedFixture);
      const amount = 500_000n;

      await expect(storage.connect(alice).withdrawBalance(amount)).to.changeEtherBalances(
        [storage, alice],
        [-amount, amount]
      );
      expect(await storage.userBalances(alice.address)).to.equal(DEPOSIT - amount);
    });

    it("Should emit BalanceWithdrawn", async function () {
      const { storage, alice } = await loadFixture(fundedFixture);
      await expect(storage.connect(alice).withdrawBalance(100n))
        .to.emit(storage, "BalanceWithdrawn")
        .withArgs(alice.address, 100n);
    });

    it("Should reject withdrawing more than the balance", async function () {
      const { storage, alice } = await loadFixture(fundedFixture);
      await expect(storage.connect(alice).withdrawBalance(DEPOSIT + 1n)).to.be.revertedWith(
        "Insufficient balance"
      );
    });

    it("Should reject a zero withdrawal", async function () {
      const { storage, alice } = await loadFixture(fundedFixture);
      await expect(storage.connect(alice).withdrawBalance(0)).to.be.revertedWith(
        "Amount must be greater than zero"
      );
    });
  });

  describe("Upload", function () {
    it("Should upload a file and emit FileUploaded", async function () {
      const { storage, alice } = await loadFixture(fundedFixture);
      await expect(storage.connect(alice).uploadFile(CID, SIZE, DAYS))
        .to.emit(storage, "FileUploaded")
        .withArgs(0n, alice.address, CID, SIZE, anyValue);
    });

    it("Should store correct metadata", async function () {
      const { storage, alice } = await loadFixture(uploadedFixture);
      const ts = BigInt(await time.latest());
      const meta = await storage.connect(alice).getFileMetadata(0);

      expect(meta.ipfsHash).to.equal(CID);
      expect(meta.owner).to.equal(alice.address);
      expect(meta.fileSize).to.equal(SIZE);
      expect(meta.uploadTimestamp).to.equal(ts);
      expect(meta.status).to.equal(0n); // Active
      expect(meta.expirationTime).to.equal(ts + DAYS * DAY);
    });

    it("Should charge the user and record revenue", async function () {
      const { storage, alice } = await loadFixture(uploadedFixture);
      expect(await storage.userBalances(alice.address)).to.equal(DEPOSIT - COST);
      expect(await storage.pendingRevenue()).to.equal(COST);
      expect(await storage.totalRevenue()).to.equal(COST);
    });

    it("Should track the user's files and increment IDs", async function () {
      const { storage, alice } = await loadFixture(uploadedFixture);
      await storage.connect(alice).uploadFile("QmSecond", SIZE, DAYS);

      const files = await storage.connect(alice).getUserFiles();
      expect(files.length).to.equal(2);
      expect(files[0]).to.equal(0n);
      expect(files[1]).to.equal(1n);
    });

    it("Should reject an empty IPFS hash", async function () {
      const { storage, alice } = await loadFixture(fundedFixture);
      await expect(storage.connect(alice).uploadFile("", SIZE, DAYS)).to.be.revertedWith(
        "IPFS hash cannot be empty"
      );
    });

    it("Should reject a file size below the minimum", async function () {
      const { storage, alice } = await loadFixture(fundedFixture);
      await expect(storage.connect(alice).uploadFile(CID, 0, DAYS)).to.be.revertedWith(
        "File size below minimum"
      );
    });

    it("Should reject a file size above the maximum", async function () {
      const { storage, alice } = await loadFixture(fundedFixture);
      const tooBig = 10n * 1024n * 1024n + 1n;
      await expect(storage.connect(alice).uploadFile(CID, tooBig, DAYS)).to.be.revertedWith(
        "File size exceeds maximum"
      );
    });

    it("Should reject a duration below the minimum", async function () {
      const { storage, alice } = await loadFixture(fundedFixture);
      await expect(storage.connect(alice).uploadFile(CID, SIZE, 29)).to.be.revertedWith(
        "Storage duration below minimum"
      );
    });

    it("Should reject a duration above the maximum", async function () {
      const { storage, alice } = await loadFixture(fundedFixture);
      await expect(storage.connect(alice).uploadFile(CID, SIZE, 366)).to.be.revertedWith(
        "Storage duration exceeds maximum"
      );
    });

    it("Should reject an upload with insufficient balance", async function () {
      const { storage, bob } = await loadFixture(deployFixture);
      await expect(storage.connect(bob).uploadFile(CID, SIZE, DAYS)).to.be.revertedWith(
        "Insufficient balance"
      );
    });
  });

  describe("Access control", function () {
    it("Should give the owner access by default", async function () {
      const { storage, alice } = await loadFixture(uploadedFixture);
      expect(await storage.hasAccess(0, alice.address)).to.equal(true);
    });

    it("Should grant access and emit AccessGranted", async function () {
      const { storage, alice, bob } = await loadFixture(uploadedFixture);
      await expect(storage.connect(alice).grantAccess(0, bob.address))
        .to.emit(storage, "AccessGranted")
        .withArgs(0n, bob.address, alice.address);

      expect(await storage.hasAccess(0, bob.address)).to.equal(true);
      const meta = await storage.connect(bob).getFileMetadata(0);
      expect(meta.ipfsHash).to.equal(CID);
    });

    it("Should block users without access", async function () {
      const { storage, carol } = await loadFixture(uploadedFixture);
      await expect(storage.connect(carol).getFileMetadata(0)).to.be.revertedWith(
        "No access to file"
      );
    });

    it("Should only let the owner grant access", async function () {
      const { storage, bob, carol } = await loadFixture(uploadedFixture);
      await expect(storage.connect(bob).grantAccess(0, carol.address)).to.be.revertedWith(
        "Not file owner"
      );
    });

    it("Should reject invalid grants", async function () {
      const { storage, alice, bob } = await loadFixture(uploadedFixture);
      await expect(
        storage.connect(alice).grantAccess(0, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid address");

      await storage.connect(alice).grantAccess(0, bob.address);
      await expect(storage.connect(alice).grantAccess(0, bob.address)).to.be.revertedWith(
        "Access already granted"
      );
    });

    it("Should reject access changes on a non-existent file", async function () {
      const { storage, alice, bob } = await loadFixture(uploadedFixture);
      await expect(storage.connect(alice).grantAccess(99, bob.address)).to.be.revertedWith(
        "File does not exist"
      );
      await expect(storage.connect(alice).getFileMetadata(99)).to.be.revertedWith(
        "File does not exist"
      );
    });

    it("Should revoke access and emit AccessRevoked", async function () {
      const { storage, alice, bob } = await loadFixture(uploadedFixture);
      await storage.connect(alice).grantAccess(0, bob.address);

      await expect(storage.connect(alice).revokeAccess(0, bob.address))
        .to.emit(storage, "AccessRevoked")
        .withArgs(0n, bob.address, alice.address);

      expect(await storage.hasAccess(0, bob.address)).to.equal(false);
      await expect(storage.connect(bob).getFileMetadata(0)).to.be.revertedWith(
        "No access to file"
      );
    });

    it("Should reject invalid revokes", async function () {
      const { storage, alice, bob, carol } = await loadFixture(uploadedFixture);
      await expect(storage.connect(alice).revokeAccess(0, alice.address)).to.be.revertedWith(
        "Cannot revoke own access"
      );
      await expect(storage.connect(alice).revokeAccess(0, bob.address)).to.be.revertedWith(
        "No access to revoke"
      );
      await expect(storage.connect(carol).revokeAccess(0, bob.address)).to.be.revertedWith(
        "Not file owner"
      );
    });
  });

  describe("Renewal and expiry", function () {
    it("Should extend the expiration and emit StorageRenewed", async function () {
      const { storage, alice } = await loadFixture(uploadedFixture);
      const before = (await storage.connect(alice).getFileMetadata(0)).expirationTime;
      const expected = before + DAYS * DAY;

      await expect(storage.connect(alice).renewStorage(0, DAYS))
        .to.emit(storage, "StorageRenewed")
        .withArgs(0n, expected, COST);

      const after = (await storage.connect(alice).getFileMetadata(0)).expirationTime;
      expect(after).to.equal(expected);
    });

    it("Should charge for renewals", async function () {
      const { storage, alice } = await loadFixture(uploadedFixture);
      await storage.connect(alice).renewStorage(0, DAYS);
      expect(await storage.userBalances(alice.address)).to.equal(DEPOSIT - 2n * COST);
      expect(await storage.pendingRevenue()).to.equal(2n * COST);
    });

    it("Should restart from now when renewing an expired file", async function () {
      const { storage, alice } = await loadFixture(uploadedFixture);
      await time.increase(Number(31n * DAY));

      await storage.connect(alice).renewStorage(0, DAYS);
      const ts = BigInt(await time.latest());
      const meta = await storage.connect(alice).getFileMetadata(0);
      expect(meta.expirationTime).to.equal(ts + DAYS * DAY);
    });

    it("Should reject renewals beyond the maximum total duration", async function () {
      const { storage, alice } = await loadFixture(uploadedFixture);
      await expect(storage.connect(alice).renewStorage(0, 365)).to.be.revertedWith(
        "Total duration exceeds maximum"
      );
    });

    it("Should reject invalid renewal inputs", async function () {
      const { storage, alice, bob } = await loadFixture(uploadedFixture);
      await expect(storage.connect(alice).renewStorage(0, 0)).to.be.revertedWith(
        "Must add at least one day"
      );
      await expect(storage.connect(alice).renewStorage(0, 366)).to.be.revertedWith(
        "Renewal exceeds maximum"
      );
      await expect(storage.connect(bob).renewStorage(0, DAYS)).to.be.revertedWith(
        "Not file owner"
      );
    });

    it("Should reject a renewal with insufficient balance", async function () {
      const { storage, alice } = await loadFixture(uploadedFixture);
      await storage.connect(alice).withdrawBalance(await storage.userBalances(alice.address));
      await expect(storage.connect(alice).renewStorage(0, DAYS)).to.be.revertedWith(
        "Insufficient balance"
      );
    });

    it("Should remove access once the file expires", async function () {
      const { storage, alice, bob } = await loadFixture(uploadedFixture);
      await storage.connect(alice).grantAccess(0, bob.address);
      expect(await storage.hasAccess(0, bob.address)).to.equal(true);

      await time.increase(Number(31n * DAY));

      expect(await storage.hasAccess(0, bob.address)).to.equal(false);
      expect(await storage.hasAccess(0, alice.address)).to.equal(false);
      await expect(storage.connect(bob).getFileMetadata(0)).to.be.revertedWith(
        "No access to file"
      );
      // Owner can still read metadata so they can renew
      const meta = await storage.connect(alice).getFileMetadata(0);
      expect(meta.ipfsHash).to.equal(CID);
    });
  });

  describe("Removal", function () {
    it("Should let the owner remove a file", async function () {
      const { storage, alice } = await loadFixture(uploadedFixture);
      await expect(storage.connect(alice).removeFile(0))
        .to.emit(storage, "FileRemoved")
        .withArgs(0n, alice.address);

      const meta = await storage.connect(alice).getFileMetadata(0);
      expect(meta.status).to.equal(1n); // Removed
      expect(await storage.hasAccess(0, alice.address)).to.equal(false);
    });

    it("Should let an operator remove a file", async function () {
      const { storage, alice, operator } = await loadFixture(uploadedFixture);
      await expect(storage.connect(operator).removeFile(0))
        .to.emit(storage, "FileRemoved")
        .withArgs(0n, operator.address);
    });

    it("Should reject removal by anyone else", async function () {
      const { storage, carol } = await loadFixture(uploadedFixture);
      await expect(storage.connect(carol).removeFile(0)).to.be.revertedWith(
        "Not owner or operator"
      );
    });

    it("Should reject removing twice or removing a missing file", async function () {
      const { storage, alice } = await loadFixture(uploadedFixture);
      await storage.connect(alice).removeFile(0);
      await expect(storage.connect(alice).removeFile(0)).to.be.revertedWith(
        "File already removed"
      );
      await expect(storage.connect(alice).removeFile(99)).to.be.revertedWith(
        "File does not exist"
      );
    });

    it("Should block access, renewals and grants on removed files", async function () {
      const { storage, alice, bob } = await loadFixture(uploadedFixture);
      await storage.connect(alice).grantAccess(0, bob.address);
      await storage.connect(alice).removeFile(0);

      await expect(storage.connect(bob).getFileMetadata(0)).to.be.revertedWith(
        "No access to file"
      );
      await expect(storage.connect(alice).renewStorage(0, DAYS)).to.be.revertedWith(
        "File not active"
      );
      await expect(storage.connect(alice).grantAccess(0, bob.address)).to.be.revertedWith(
        "File not active"
      );
      await expect(storage.connect(alice).revokeAccess(0, bob.address)).to.be.revertedWith(
        "File not active"
      );
    });
  });

  describe("Revenue", function () {
    it("Should send only earned revenue to the treasury", async function () {
      const { storage, owner, treasury } = await loadFixture(uploadedFixture);
      await expect(storage.connect(owner).withdrawRevenue())
        .to.emit(storage, "RevenueWithdrawn")
        .withArgs(treasury.address, COST);

      expect(await storage.pendingRevenue()).to.equal(0n);
    });

    it("Should move the right amount of ETH", async function () {
      const { storage, owner, treasury } = await loadFixture(uploadedFixture);
      await expect(storage.connect(owner).withdrawRevenue()).to.changeEtherBalances(
        [storage, treasury],
        [-COST, COST]
      );
    });

    it("Should never touch user deposits", async function () {
      const { storage, owner, alice } = await loadFixture(uploadedFixture);
      await storage.connect(owner).withdrawRevenue();

      expect(await ethers.provider.getBalance(await storage.getAddress())).to.equal(
        DEPOSIT - COST
      );
      expect(await storage.userBalances(alice.address)).to.equal(DEPOSIT - COST);

      // The user can still withdraw everything that's left
      await expect(
        storage.connect(alice).withdrawBalance(DEPOSIT - COST)
      ).to.changeEtherBalance(alice, DEPOSIT - COST);
    });

    it("Should reject withdrawal when there is no revenue", async function () {
      const { storage, owner } = await loadFixture(fundedFixture);
      await expect(storage.connect(owner).withdrawRevenue()).to.be.revertedWith(
        "No revenue to withdraw"
      );
    });

    it("Should restrict revenue withdrawal to admins", async function () {
      const { storage, alice } = await loadFixture(uploadedFixture);
      await expect(storage.connect(alice).withdrawRevenue()).to.be.revertedWithCustomError(
        storage,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("Should pay a new treasury after updateTreasury", async function () {
      const { storage, owner, carol } = await loadFixture(uploadedFixture);
      await storage.connect(owner).updateTreasury(carol.address);
      await expect(storage.connect(owner).withdrawRevenue()).to.changeEtherBalance(
        carol,
        COST
      );
    });
  });

  describe("Admin", function () {
    it("Should calculate storage cost", async function () {
      const { storage } = await loadFixture(deployFixture);
      expect(await storage.calculateStorageCost(SIZE, DAYS)).to.equal(COST);
    });

    it("Should update the price", async function () {
      const { storage, owner } = await loadFixture(deployFixture);
      await expect(storage.connect(owner).updatePrice(5))
        .to.emit(storage, "PriceUpdated")
        .withArgs(5n);
      expect(await storage.calculateStorageCost(SIZE, DAYS)).to.equal(COST * 5n);
    });

    it("Should update the treasury and reject zero", async function () {
      const { storage, owner, carol } = await loadFixture(deployFixture);
      await expect(storage.connect(owner).updateTreasury(carol.address))
        .to.emit(storage, "TreasuryUpdated")
        .withArgs(carol.address);
      await expect(
        storage.connect(owner).updateTreasury(ethers.ZeroAddress)
      ).to.be.revertedWith("Treasury address cannot be zero");
    });

    it("Should restrict admin functions", async function () {
      const { storage, alice } = await loadFixture(deployFixture);
      await expect(storage.connect(alice).updatePrice(5)).to.be.revertedWithCustomError(
        storage,
        "AccessControlUnauthorizedAccount"
      );
      await expect(
        storage.connect(alice).updateTreasury(alice.address)
      ).to.be.revertedWithCustomError(storage, "AccessControlUnauthorizedAccount");
      await expect(
        storage.connect(alice).grantOperator(alice.address)
      ).to.be.revertedWithCustomError(storage, "AccessControlUnauthorizedAccount");
    });
  });

  describe("Emergency pause", function () {
    it("Should pause and unpause", async function () {
      const { storage, owner } = await loadFixture(deployFixture);
      await storage.connect(owner).pause();
      expect(await storage.paused()).to.equal(true);
      await storage.connect(owner).unpause();
      expect(await storage.paused()).to.equal(false);
    });

    it("Should restrict pausing to admins", async function () {
      const { storage, alice } = await loadFixture(deployFixture);
      await expect(storage.connect(alice).pause()).to.be.revertedWithCustomError(
        storage,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("Should block deposits, uploads, renewals and grants while paused", async function () {
      const { storage, owner, alice, bob } = await loadFixture(uploadedFixture);
      await storage.connect(owner).pause();

      await expect(
        storage.connect(alice).addFunds({ value: 1n })
      ).to.be.revertedWithCustomError(storage, "EnforcedPause");
      await expect(
        storage.connect(alice).uploadFile(CID, SIZE, DAYS)
      ).to.be.revertedWithCustomError(storage, "EnforcedPause");
      await expect(
        storage.connect(alice).renewStorage(0, DAYS)
      ).to.be.revertedWithCustomError(storage, "EnforcedPause");
      await expect(
        storage.connect(alice).grantAccess(0, bob.address)
      ).to.be.revertedWithCustomError(storage, "EnforcedPause");
    });

    it("Should still let users withdraw while paused", async function () {
      const { storage, owner, alice } = await loadFixture(uploadedFixture);
      await storage.connect(owner).pause();
      await expect(storage.connect(alice).withdrawBalance(1000n)).to.changeEtherBalance(
        alice,
        1000n
      );
    });

    it("Should resume normal operation after unpausing", async function () {
      const { storage, owner, alice } = await loadFixture(uploadedFixture);
      await storage.connect(owner).pause();
      await storage.connect(owner).unpause();
      await expect(storage.connect(alice).uploadFile("QmAfter", SIZE, DAYS)).to.emit(
        storage,
        "FileUploaded"
      );
    });
  });
});