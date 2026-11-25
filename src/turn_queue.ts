/**
 * Per-session turn queue: serialize agent turns so only ONE prompt is in
 * flight per session at a time.
 *
 * Why: two messages sent close together on the same session produce two
 * concurrent `session.prompt()` + `finalText()` flows. Both `finalText()`
 * calls read the session's LAST assistant text, so both deliver the same
 * answer (duplicate replies). Serializing turns removes the race entirely —
 * the second message waits for the first to finish, then gets its own answer.
 *
 * This is the gateway's equivalent of Hermes' busy-session guard.
 */
type Job = () => Promise<void>

export class TurnQueue {
  private readonly tails = new Map<string, Promise<void>>()

  /** Run a turn for a session, chained behind any earlier turn for it. */
  run(sessionID: string, job: Job): Promise<void> {
    const previous = this.tails.get(sessionID) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(job)
    // Keep a settled tail so a rejected job can't poison later turns.
    const tail = next.catch(() => {})
    this.tails.set(sessionID, tail)
    void tail.then(() => {
      if (this.tails.get(sessionID) === tail) this.tails.delete(sessionID)
    })
    return next
  }
}
