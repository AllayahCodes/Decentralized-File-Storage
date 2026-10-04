# Decentralized File Storage

A Solidity smart contract that manages decentralized file storage using **IPFS** for the files and **Ethereum** for metadata, access control and payments.

Only the IPFS content identifier (CID) and metadata are stored on-chain. The files themselves never touch the blockchain.

## How it works

1. A user uploads a file to IPFS and receives a CID.
2. The user deposits ETH into the contract (`addFunds`).
3. The user registers the file (`uploadFile`) with its CID, size and storage duration. The cost (`size × days × price per byte per day`) is deducted from their deposit.
4. The owner can grant or revoke access to other addresses, renew storage, or remove the file.
5. Earned revenue accumulates in the contract. An admin calls `withdrawRevenue()` to send it to the `treasury` address, which can be any wallet or a payment-splitting contract.

## Features

- **Metadata on-chain:** CID, owner, size, upload time, status and expiry stored in a struct.
- **Access control:** owners grant and revoke per-file access. Access ends automatically when a file expires or is removed.
- **Pay-per-byte pricing:** configurable price, with minimum and maximum file sizes and storage durations.
- **Renewable storage:** extend a file's period. Renewing an expired file restarts from the current time, and total duration is capped.
- **Safe accounting:** user deposits and earned revenue are tracked separately. Admin withdrawals can only move earned revenue, never user deposits. Users can withdraw their unspent balance at any time.
- **Roles:** `ADMIN_ROLE` manages pricing, treasury, pausing and revenue. `OPERATOR_ROLE` can remove files for moderation.
- **Emergency pause:** blocks deposits, uploads, renewals and new access grants.
