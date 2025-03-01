import { Address } from './address'
import { bigIntToHex } from './bytes'
import { TypeOutput, toType } from './types'

import type { AddressLike, BigIntLike } from './types'

export type WithdrawalData = {
  index: BigIntLike
  validatorIndex: BigIntLike
  address: AddressLike
  amount: BigIntLike
}

export interface JsonRpcWithdrawal {
  index: string // QUANTITY - bigint 8 bytes
  validatorIndex: string // QUANTITY - bigint 8 bytes
  address: string // DATA, 20 Bytes  address to withdraw to
  amount: string // QUANTITY - bigint amount in wei 32 bytes
}

export type WithdrawalBuffer = [Buffer, Buffer, Buffer, Buffer]

export class Withdrawal {
  constructor(
    public readonly index: bigint,
    public readonly validatorIndex: bigint,
    public readonly address: Address,
    public readonly amount: bigint
  ) {}

  public static fromWithdrawalData(withdrawalData: WithdrawalData) {
    const {
      index: indexData,
      validatorIndex: validatorIndexData,
      address: addressData,
      amount: amountData,
    } = withdrawalData
    const index = toType(indexData, TypeOutput.BigInt)
    const validatorIndex = toType(validatorIndexData, TypeOutput.BigInt)
    const address = new Address(toType(addressData, TypeOutput.Buffer))
    const amount = toType(amountData, TypeOutput.BigInt)

    return new Withdrawal(index, validatorIndex, address, amount)
  }

  public static fromValuesArray(withdrawalArray: WithdrawalBuffer) {
    if (withdrawalArray.length !== 4) {
      throw Error(`Invalid withdrawalArray length expected=4 actual=${withdrawalArray.length}`)
    }
    const [index, validatorIndex, address, amount] = withdrawalArray
    return Withdrawal.fromWithdrawalData({ index, validatorIndex, address, amount })
  }

  /**
   * Convert a withdrawal to a buffer array
   * @param withdrawal the withdrawal to convert
   * @returns buffer array of the withdrawal
   */
  public static toBufferArray(withdrawal: Withdrawal | WithdrawalData): WithdrawalBuffer {
    const { index, validatorIndex, address, amount } = withdrawal
    const indexBuffer =
      toType(index, TypeOutput.BigInt) === BigInt(0)
        ? Buffer.alloc(0)
        : toType(index, TypeOutput.Buffer)
    const validatorIndexBuffer =
      toType(validatorIndex, TypeOutput.BigInt) === BigInt(0)
        ? Buffer.alloc(0)
        : toType(validatorIndex, TypeOutput.Buffer)
    let addressBuffer
    if (address instanceof Address) {
      addressBuffer = (<Address>address).buf
    } else {
      addressBuffer = toType(address, TypeOutput.Buffer)
    }
    const amountBuffer =
      toType(amount, TypeOutput.BigInt) === BigInt(0)
        ? Buffer.alloc(0)
        : toType(amount, TypeOutput.Buffer)

    return [indexBuffer, validatorIndexBuffer, addressBuffer, amountBuffer]
  }

  raw() {
    return Withdrawal.toBufferArray(this)
  }

  toJSON() {
    return {
      index: bigIntToHex(this.index),
      validatorIndex: bigIntToHex(this.validatorIndex),
      address: '0x' + this.address.buf.toString('hex'),
      amount: bigIntToHex(this.amount),
    }
  }
}
