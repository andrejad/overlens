// REQ_TEST_024: print the seed and the frozen day once per Vitest run, so a failure can be replayed.
import { envSeed, testToday } from './testToday'

export default function setup() {
  const seed = envSeed()
  console.log(`TEST_SEED=${seed} (frozen today ${testToday(seed).toDateString()}, TZ=${process.env.TZ})`)
}
