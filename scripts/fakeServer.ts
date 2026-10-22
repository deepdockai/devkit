import { startFakeApi } from '../tests/fakeApi.ts'

// A local stand-in for the API, for trying the built CLI by hand. Login and key requests are
// approved at once; the sign-in and key values it hands out are invented.
const api = await startFakeApi()
process.stdout.write(`${api.url}\n`)
process.stderr.write(
  `Fake API on ${api.url}. Use: DEEPDOCK_BASE_URL=${api.url} node dist/deepdock.js auth login\n`,
)
