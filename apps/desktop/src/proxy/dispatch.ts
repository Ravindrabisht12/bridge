import { ErrorCodes, isRequest, type JsonRpcMessage } from '@shared/jsonrpc'

/** An inspection failure must never turn an unapproved tool call into an upstream call. */
export async function dispatchClientMessage(
  message: JsonRpcMessage,
  handle: (message: JsonRpcMessage) => Promise<void>,
  toClient: (message: JsonRpcMessage) => void,
  log: (message: string) => void
): Promise<void> {
  try { await handle(message) } catch {
    log('Client message inspection failed; request was not retried or forwarded.')
    if (isRequest(message)) {
      toClient({ jsonrpc: '2.0', id: message.id, error: {
        code: ErrorCodes.InternalError,
        message: 'Bridge could not evaluate this request safely. It was not retried. Check Bridge before trying again.'
      } })
    }
  }
}
