# PLC Setup

[简体中文](zh-CN/plc-setup.md)

This extension reads Siemens S7 DB bytes through the S7 protocol. Configure the PLC first, especially for S7-1200 and S7-1500 CPUs.

Reference: [S7NetPlus S7-1200/1500 notes](https://github.com/S7NetPlus/s7netplus/wiki/S7-1200-1500-Notes).

## Supported DB Shape

- Use global DBs.
- Use non-optimized DB access.
- Export the DB source from TIA Portal as a `.db` file.
- Keep UDT definitions in the same exported file when possible, because external UDT imports are not yet resolved by the extension.

## Configure DB Blocks

For each DB block that should be monitored:

1. Open the project in TIA Portal.
2. In `Program blocks`, select the DB.
3. Open `Properties`.
4. Disable `Optimized block access`.
5. Compile and download the DB to the PLC.
6. Export the DB source and open the `.db` file in VS Code.

If optimized access is enabled, monitored values may be empty or incorrect because the byte layout may not match the exported `.db` file.

## Configure CPU Access

For S7-1200 and S7-1500 CPUs:

1. Select the CPU in TIA Portal.
2. Open `Properties`.
3. Open the `Protection & Security` or `Protection` section.
4. Set the access level to full access.
5. Enable access with PUT/GET communication from a remote partner.
6. Download the hardware configuration to the PLC.

The exact wording can vary by TIA Portal version and CPU firmware.

## Check Network Parameters

- The PLC must be reachable from the computer running VS Code.
- TCP port `102` must be reachable.
- Default S7-1200/S7-1500 connection parameters are usually:
  - Rack: `0`
  - Slot: `1`
- Some older S7-300/S7-400 setups may use Slot `2`.

## DB Block Numbers

TIA Portal exports can contain symbolic DB names without the actual runtime DB number. When this happens:

1. Open the `.db` file in S7 DB Monitor.
2. Find the DB block in the left list.
3. Enter the actual PLC DB number, such as `20` for `DB20`.
4. Use `Read Once` or `Continuous` after connecting.

The entered DB number is saved per `.db` file in VS Code workspace storage.

## Troubleshooting

- `PLC is not connected.`: connect before reading.
- `Set DB number for ...`: enter the actual DB block number in the left DB list.
- Empty or incorrect values: verify that optimized block access is disabled and the downloaded DB matches the exported `.db` file.
- Connection failure: verify PLC IP address, rack, slot, network route and port `102`.
- S7-1200/S7-1500 read failure: verify full access and PUT/GET access in CPU protection settings.

