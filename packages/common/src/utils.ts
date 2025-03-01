import { intToHex, isHexPrefixed, stripHexPrefix } from '@ethereumjs/util'

import { Hardfork } from './enums'

type ConfigHardfork = { name: string; block: number }
/**
 * Transforms Geth formatted nonce (i.e. hex string) to 8 byte 0x-prefixed string used internally
 * @param nonce string parsed from the Geth genesis file
 * @returns nonce as a 0x-prefixed 8 byte string
 */
function formatNonce(nonce: string): string {
  if (!nonce || nonce === '0x0') {
    return '0x0000000000000000'
  }
  if (isHexPrefixed(nonce)) {
    return '0x' + stripHexPrefix(nonce).padStart(16, '0')
  }
  return '0x' + nonce.padStart(16, '0')
}

/**
 * Converts Geth genesis parameters to an EthereumJS compatible `CommonOpts` object
 * @param json object representing the Geth genesis file
 * @param optional mergeForkIdPostMerge which clarifies the placement of MergeForkIdTransition
 * hardfork, which by default is post merge as with the merged eth networks but could also come
 * before merge like in kiln genesis
 * @returns genesis parameters in a `CommonOpts` compliant object
 */
function parseGethParams(json: any, mergeForkIdPostMerge: boolean = true) {
  const { name, config, difficulty, mixHash, gasLimit, coinbase, baseFeePerGas } = json
  let { extraData, timestamp, nonce } = json
  const { chainId } = config

  // geth is not strictly putting empty fields with a 0x prefix
  if (extraData === '') {
    extraData = '0x'
  }
  // geth may use number for timestamp
  if (!isHexPrefixed(timestamp)) {
    timestamp = intToHex(parseInt(timestamp))
  }
  // geth may not give us a nonce strictly formatted to an 8 byte hex string
  if (nonce.length !== 18) {
    nonce = formatNonce(nonce)
  }

  // EIP155 and EIP158 are both part of Spurious Dragon hardfork and must occur at the same time
  // but have different configuration parameters in geth genesis parameters
  if (config.eip155Block !== config.eip158Block) {
    throw new Error(
      'EIP155 block number must equal EIP 158 block number since both are part of SpuriousDragon hardfork and the client only supports activating the full hardfork'
    )
  }

  const params: any = {
    name,
    chainId,
    networkId: chainId,
    genesis: {
      timestamp,
      gasLimit: parseInt(gasLimit), // geth gasLimit and difficulty are hex strings while ours are `number`s
      difficulty: parseInt(difficulty),
      nonce,
      extraData,
      mixHash,
      coinbase,
      baseFeePerGas,
    },
    bootstrapNodes: [],
    consensus:
      config.clique !== undefined
        ? {
            type: 'poa',
            algorithm: 'clique',
            clique: {
              // The recent geth genesis seems to be using blockperiodseconds
              // and epochlength for clique specification
              // see: https://hackmd.io/PqZgMpnkSWCWv5joJoFymQ
              period: config.clique.period ?? config.clique.blockperiodseconds,
              epoch: config.clique.epoch ?? config.clique.epochlength,
            },
          }
        : {
            type: 'pow',
            algorithm: 'ethash',
            ethash: {},
          },
  }

  const forkMap: { [key: string]: { name: string; postMerge?: boolean } } = {
    [Hardfork.Homestead]: { name: 'homesteadBlock' },
    [Hardfork.Dao]: { name: 'daoForkBlock' },
    [Hardfork.TangerineWhistle]: { name: 'eip150Block' },
    [Hardfork.SpuriousDragon]: { name: 'eip155Block' },
    [Hardfork.Byzantium]: { name: 'byzantiumBlock' },
    [Hardfork.Constantinople]: { name: 'constantinopleBlock' },
    [Hardfork.Petersburg]: { name: 'petersburgBlock' },
    [Hardfork.Istanbul]: { name: 'istanbulBlock' },
    [Hardfork.MuirGlacier]: { name: 'muirGlacierBlock' },
    [Hardfork.Berlin]: { name: 'berlinBlock' },
    [Hardfork.London]: { name: 'londonBlock' },
    [Hardfork.MergeForkIdTransition]: { name: 'mergeForkBlock', postMerge: mergeForkIdPostMerge },
    [Hardfork.Shanghai]: { name: 'shanghaiBlock', postMerge: true },
  }

  // forkMapRev is the map from config field name to Hardfork
  const forkMapRev = Object.keys(forkMap).reduce((acc, elem) => {
    acc[forkMap[elem].name] = elem
    return acc
  }, {} as { [key: string]: string })
  const configHardforkNames = Object.keys(config).filter((key) => forkMapRev[key] !== undefined)

  params.hardforks = configHardforkNames
    .map((nameBlock) => ({
      name: forkMapRev[nameBlock],
      block: config[nameBlock],
    }))
    .filter((fork) => fork.block !== null && fork.block !== undefined)

  // sort with block
  params.hardforks.sort(function (a: ConfigHardfork, b: ConfigHardfork) {
    return a.block - b.block
  })
  params.hardforks.unshift({ name: Hardfork.Chainstart, block: 0 })

  if (config.terminalTotalDifficulty !== undefined) {
    // Following points need to be considered for placement of merge hf
    // - Merge hardfork can't be placed at genesis
    // - Place merge hf before any hardforks that require CL participation for e.g. withdrawals
    // - Merge hardfork has to be placed just after genesis if any of the genesis hardforks make CL
    //   necessary for e.g. withdrawals
    const mergeConfig = {
      name: Hardfork.Merge,
      ttd: config.terminalTotalDifficulty,
      block: null,
    }

    // If any of the genesis block require merge, then we need merge just right after genesis
    const isMergeJustPostGenesis: boolean = params.hardforks
      .filter((hf: ConfigHardfork) => hf.block === 0)
      .reduce(
        (acc: boolean, hf: ConfigHardfork) => acc || forkMap[hf.name]?.postMerge === true,
        false
      )

    // Merge hardfork has to be placed before first non-zero block hardfork that is dependent
    // on merge or first non zero block hardfork if any of genesis hardforks require merge
    const postMergeIndex = params.hardforks.findIndex(
      (hf: any) => (isMergeJustPostGenesis || forkMap[hf.name]?.postMerge === true) && hf.block > 0
    )
    if (postMergeIndex !== -1) {
      params.hardforks.splice(postMergeIndex, 0, mergeConfig)
    } else {
      params.hardforks.push(mergeConfig)
    }
  }
  return params
}

/**
 * Parses a genesis.json exported from Geth into parameters for Common instance
 * @param json representing the Geth genesis file
 * @param name optional chain name
 * @returns parsed params
 */
export function parseGethGenesis(json: any, name?: string, mergeForkIdPostMerge?: boolean) {
  try {
    if (['config', 'difficulty', 'gasLimit', 'alloc'].some((field) => !(field in json))) {
      throw new Error('Invalid format, expected geth genesis fields missing')
    }
    if (name !== undefined) {
      json.name = name
    }
    return parseGethParams(json, mergeForkIdPostMerge)
  } catch (e: any) {
    throw new Error(`Error parsing parameters file: ${e.message}`)
  }
}
