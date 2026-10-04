const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const { ethers, network } = hre;
  console.log("Starting DecentralizedStorage deployment...\n");

  const signers = await ethers.getSigners();
  const deployer = signers[0];

  // Treasury: use TREASURY_ADDRESS (e.g. a PaymentSplitter) if set.
  // Locally, fall back to a second signer; otherwise to the deployer.
  const treasuryAddress =
    process.env.TREASURY_ADDRESS || (signers[1] ? signers[1].address : deployer.address);
  const pricePerBytePerDay = process.env.PRICE_PER_BYTE_PER_DAY || "1"; // wei

  console.log("Deployer:", deployer.address);
  console.log(
    "Balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH"
  );
  console.log("Treasury:", treasuryAddress);
  console.log("Price per byte per day:", pricePerBytePerDay, "wei\n");

  // Deploy
  const Storage = await ethers.getContractFactory("DecentralizedStorage");
  const storage = await Storage.deploy(treasuryAddress, pricePerBytePerDay);
  await storage.waitForDeployment();

  const contractAddress = await storage.getAddress();
  const receipt = await storage.deploymentTransaction().wait();

  console.log("DecentralizedStorage deployed");
  console.log("Address:", contractAddress);
  console.log("Network:", network.name);
  console.log("Gas used:", receipt.gasUsed.toString());

  // Optional operator role (can remove files for moderation)
  if (process.env.OPERATOR_ADDRESS) {
    await (await storage.grantOperator(process.env.OPERATOR_ADDRESS)).wait();
    console.log("Operator role granted to", process.env.OPERATOR_ADDRESS);
  }

  // Sample data on local networks only
  if (network.name === "hardhat" || network.name === "localhost") {
    console.log("\nCreating sample file...");
    await (await storage.addFunds({ value: 1_000_000n })).wait();
    await (await storage.uploadFile("QmSampleCid123", 1000, 30)).wait();
    console.log("Sample file uploaded (file ID 0)");
  }

  // Save deployment info so a frontend / IPFS client can read it
  const deploymentInfo = {
    contractAddress,
    network: network.name,
    deployer: deployer.address,
    treasury: treasuryAddress,
    pricePerBytePerDay,
    deploymentTime: new Date().toISOString(),
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${network.name}.json`),
    JSON.stringify(deploymentInfo, null, 2)
  );

  console.log("\nDeployment summary:", JSON.stringify(deploymentInfo, null, 2));
  return contractAddress;
}

main()
  .then((address) => {
    console.log(`\nContract deployed at: ${address}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });