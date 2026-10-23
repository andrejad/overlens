// A test that covers several cases of one requirement runs them one after another as labelled steps; a
// failure names the step it came from, so a merged test still says which behaviour broke.
export async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    if (e instanceof Error) e.message = `[${label}] ${e.message}`
    throw e
  }
}
