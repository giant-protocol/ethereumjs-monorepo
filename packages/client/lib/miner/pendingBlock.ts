import { randomBytes } from 'crypto'

import type { Config } from '../config'
import type { TxPool } from '../service/txpool'
import type { Block, HeaderData } from '@ethereumjs/block'
import type { TypedTransaction } from '@ethereumjs/tx'
import type { WithdrawalData } from '@ethereumjs/util'
import type { TxReceipt, VM } from '@ethereumjs/vm'
import type { BlockBuilder } from '@ethereumjs/vm/dist/buildBlock'

interface PendingBlockOpts {
  /* Config */
  config: Config

  /* Tx Pool */
  txPool: TxPool
}

/**
 * In the future this class should build a pending block by keeping the
 * transaction set up-to-date with the state of local mempool until called.
 *
 * For now this simple implementation just adds txs from the pool when
 * started and called.
 */
export class PendingBlock {
  config: Config
  txPool: TxPool
  pendingPayloads: [payloadId: Buffer, builder: BlockBuilder][] = []

  constructor(opts: PendingBlockOpts) {
    this.config = opts.config
    this.txPool = opts.txPool
  }

  /**
   * Starts building a pending block with the given payload
   * @returns an 8-byte payload identifier to call {@link BlockBuilder.build} with
   */
  async start(
    vm: VM,
    parentBlock: Block,
    headerData: Partial<HeaderData> = {},
    withdrawals?: WithdrawalData[]
  ) {
    const number = parentBlock.header.number + BigInt(1)
    const { gasLimit } = parentBlock.header
    const baseFeePerGas =
      vm._common.isActivatedEIP(1559) === true ? parentBlock.header.calcNextBaseFee() : undefined

    // Set the state root to ensure the resulting state
    // is based on the parent block's state
    await vm.eei.setStateRoot(parentBlock.header.stateRoot)

    if (typeof vm.blockchain.getTotalDifficulty !== 'function') {
      throw new Error('cannot get iterator head: blockchain has no getTotalDifficulty function')
    }
    const td = await vm.blockchain.getTotalDifficulty(parentBlock.hash())

    const builder = await vm.buildBlock({
      parentBlock,
      headerData: {
        ...headerData,
        number,
        gasLimit,
        baseFeePerGas,
      },
      withdrawals,
      blockOpts: {
        putBlockIntoBlockchain: false,
        hardforkByTTD: td,
      },
    })

    const payloadId = randomBytes(8)
    this.pendingPayloads.push([payloadId, builder])

    // Add current txs in pool
    const txs = await this.txPool.txsByPriceAndNonce(vm, baseFeePerGas)
    this.config.logger.info(
      `Pending: Assembling block from ${txs.length} eligible txs (baseFee: ${baseFeePerGas})`
    )
    let index = 0
    let blockFull = false
    while (index < txs.length && !blockFull) {
      try {
        await builder.addTransaction(txs[index])
      } catch (error: any) {
        if (error.message === 'tx has a higher gas limit than the remaining gas in the block') {
          if (builder.gasUsed > gasLimit - BigInt(21000)) {
            // If block has less than 21000 gas remaining, consider it full
            blockFull = true
            this.config.logger.info(
              `Pending: Assembled block full (gasLeft: ${gasLimit - builder.gasUsed})`
            )
          }
        } else {
          // If there is an error adding a tx, it will be skipped
          this.config.logger.debug(
            `Pending: Skipping tx 0x${txs[index]
              .hash()
              .toString('hex')}, error encountered when trying to add tx:\n${error}`
          )
        }
      }
      index++
    }
    return payloadId
  }

  /**
   * Stops a pending payload
   */
  stop(payloadId: Buffer) {
    const payload = this.pendingPayloads.find((p) => p[0].equals(payloadId))
    if (!payload) return
    // Revert blockBuilder
    void payload[1].revert()
    // Remove from pendingPayloads
    this.pendingPayloads = this.pendingPayloads.filter((p) => !p[0].equals(payloadId))
  }

  /**
   * Returns the completed block
   */
  async build(payloadId: Buffer): Promise<void | [block: Block, receipts: TxReceipt[]]> {
    const payload = this.pendingPayloads.find((p) => p[0].equals(payloadId))
    if (!payload) {
      return
    }
    const builder = payload[1]
    const { vm, headerData } = builder as any

    // Add new txs that the pool received
    const txs = (await this.txPool.txsByPriceAndNonce(vm, headerData.baseFeePerGas)).filter(
      (tx) =>
        (builder as any).transactions.some((t: TypedTransaction) => t.hash().equals(tx.hash())) ===
        false
    )
    this.config.logger.info(`Pending: Adding ${txs.length} additional eligible txs`)
    let index = 0
    let blockFull = false
    while (index < txs.length && !blockFull) {
      try {
        await builder.addTransaction(txs[index])
      } catch (error: any) {
        if (error.message === 'tx has a higher gas limit than the remaining gas in the block') {
          if (builder.gasUsed > (builder as any).headerData.gasLimit - BigInt(21000)) {
            // If block has less than 21000 gas remaining, consider it full
            blockFull = true
            this.config.logger.info(`Pending: Assembled block full`)
          }
        } else {
          // If there is an error adding a tx, it will be skipped
          this.config.logger.debug(
            `Pending: Skipping tx 0x${txs[index]
              .hash()
              .toString('hex')}, error encountered when trying to add tx:\n${error}`
          )
        }
      }
      index++
    }

    const block = await builder.build()
    const withdrawalsStr = block.withdrawals ? ` withdrawals=${block.withdrawals.length}` : ''
    this.config.logger.info(
      `Pending: Built block number=${block.header.number} txs=${
        block.transactions.length
      }${withdrawalsStr} hash=${block.hash().toString('hex')}`
    )

    // Remove from pendingPayloads
    this.pendingPayloads = this.pendingPayloads.filter((p) => !p[0].equals(payloadId))

    return [block, builder.transactionReceipts]
  }
}
