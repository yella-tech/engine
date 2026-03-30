import { runBenchmarkCli } from './benchmarks/run.js'

const legacyTarget = process.argv[2]

const mappedArgs =
  legacyTarget === 'synthetic'
    ? ['api-mixed__fleet-c20']
    : legacyTarget === 'realistic'
      ? ['api-mixed__fleet-c50']
      : process.argv.slice(2)

runBenchmarkCli(mappedArgs).catch((error) => {
  console.error(error)
  process.exit(1)
})
