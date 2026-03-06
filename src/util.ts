export function safeCallHook<Args extends unknown[]>(
  fn: ((...args: Args) => void) | undefined,
  args: Args,
  onError?: (error: unknown, context: string) => void,
  context?: string,
): void {
  if (!fn) return
  try {
    fn(...args)
  } catch (err) {
    onError?.(err, context ?? 'hook')
  }
}
