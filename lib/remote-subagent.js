/** Remote dsh sessions as a dsh subagent backend + one-shot delegation helper. */
import { randomUUID } from 'node:crypto'

/** Flatten dsh ContentBlock[] into the text the remote agent receives. */
export function promptText(prompt) {
  if (!Array.isArray(prompt)) return ''
  const parts = []
  for (const block of prompt) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function delay(ms, signal) {
  return new Promise(function (resolve) {
    if (signal !== undefined && signal !== null && signal.aborted) return resolve()
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', finish)
      resolve()
    }
    if (signal !== undefined && signal !== null) signal.addEventListener('abort', finish, { once: true })
  })
}

function messageOf(error) {
  return String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
}

function itemOf(listResult) {
  if (listResult === undefined || listResult.ok !== true || listResult.value === undefined) return undefined
  const items = Array.isArray(listResult.value.items) ? listResult.value.items : []
  return items
}

async function cancelQuietly(remoteRpc, host, sessionId) {
  try { await remoteRpc(host, 'session/cancel', { request: { sessionId: sessionId } }, 10000) } catch {}
}

function assistantTextFromEvent(record) {
  const event = record !== null && typeof record === 'object' ? record.event : undefined
  if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') return ''
  const data = event.data !== null && typeof event.data === 'object' ? event.data : undefined
  const message = data !== undefined && data.message !== null && typeof data.message === 'object' ? data.message : undefined
  if (message === undefined || message.role !== 'assistant' || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('')
}

/** Read the final assistant message from the full remote transcript (turnOutline truncates to 120 chars). */
async function readFullAssistant(remoteRpc, host, sessionId, throughSeq) {
  if (typeof throughSeq !== 'number' || throughSeq < 0) return ''
  const page = await remoteRpc(host, 'session/page', {
    request: {
      address: { kind: 'session', sessionId: sessionId },
      throughSeq: throughSeq,
      maxMessages: 200,
    },
  }, 30000)
  if (page === undefined || page.ok !== true || page.value === undefined || !Array.isArray(page.value.records)) return ''
  let text = ''
  for (const record of page.value.records) {
    const candidate = assistantTextFromEvent(record)
    if (candidate !== '') text = candidate
  }
  return text
}

async function waitForTurn(remoteRpc, host, sessionId, options) {
  const signal = options.signal
  const baseline = typeof options.baseline === 'number' && options.baseline >= 0 ? options.baseline : 0
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 15 * 60 * 1000
  const pollIntervalMs = typeof options.pollIntervalMs === 'number' && options.pollIntervalMs >= 250 ? options.pollIntervalMs : 1200
  const deadline = Date.now() + timeoutMs
  let lastText = ''
  for (;;) {
    if (signal !== undefined && signal !== null && signal.aborted) {
      await cancelQuietly(remoteRpc, host, sessionId)
      return { text: lastText, stopReason: 'aborted' }
    }
    await delay(pollIntervalMs, signal)
    if (signal !== undefined && signal !== null && signal.aborted) {
      await cancelQuietly(remoteRpc, host, sessionId)
      return { text: lastText, stopReason: 'aborted' }
    }
    let listed
    try {
      listed = await remoteRpc(host, 'session/list', { _request: {} }, 30000)
    } catch (error) {
      if (Date.now() > deadline) return { text: lastText, stopReason: 'error', diagnostic: 'remote session/list failed: ' + messageOf(error) }
      continue
    }
    const items = itemOf(listed)
    const session = items === undefined ? undefined : items.find(function (item) { return item !== null && typeof item === 'object' && item.sessionId === sessionId })
    if (session === undefined) {
      if (Date.now() > deadline) return { text: lastText, stopReason: 'error', diagnostic: 'remote session disappeared before completion' }
      continue
    }
    const values = session.projections !== null && typeof session.projections === 'object' ? session.projections.values : undefined
    const outline = values !== null && typeof values === 'object' && Array.isArray(values.turnOutline) ? values.turnOutline : []
    if (outline.length > 0) {
      const last = outline[outline.length - 1]
      if (last !== null && typeof last === 'object' && typeof last.response === 'string' && last.response !== '') lastText = last.response
    }
    if (session.running !== true && outline.length > baseline && lastText !== '') {
      const throughSeq = session.projections !== null && typeof session.projections === 'object' && typeof session.projections.asOfSeq === 'number' ? session.projections.asOfSeq : undefined
      let full = ''
      try { full = await readFullAssistant(remoteRpc, host, sessionId, throughSeq) } catch {}
      return { text: full === '' ? lastText : full, stopReason: 'completed' }
    }
    if (Date.now() > deadline) {
      await cancelQuietly(remoteRpc, host, sessionId)
      return { text: lastText, stopReason: 'error', diagnostic: 'timed out after ' + String(timeoutMs) + 'ms waiting for the remote turn' }
    }
  }
}

/**
 * Start a remote dsh session (or continue one) and return a dsh SubagentRun-like handle.
 * The returned result never rejects for remote-level failures; it settles with a stopReason.
 */
export async function startRemoteSubagent(host, remoteRpc, options) {
  const controller = new AbortController()
  const parentSignal = options.signal
  const onAbort = function () { controller.abort() }
  if (parentSignal !== undefined && parentSignal !== null) {
    if (parentSignal.aborted) controller.abort()
    else parentSignal.addEventListener('abort', onAbort, { once: true })
  }
  const detach = function () {
    if (parentSignal !== undefined && parentSignal !== null) parentSignal.removeEventListener('abort', onAbort)
  }
  let sessionId = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : undefined
  let baseline = 0
  try {
    if (sessionId === undefined) {
      const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : undefined
      const created = await remoteRpc(host, 'session/create', cwd === undefined ? { request: {} } : { request: { cwd: cwd } }, 30000)
      if (created === undefined || created.ok !== true || created.value === undefined || typeof created.value.sessionId !== 'string') {
        detach()
        throw new Error('remote session/create failed on ' + host.id)
      }
      sessionId = created.value.sessionId
    } else {
      const current = await remoteRpc(host, 'session/projections', { request: { sessionId: sessionId } }, 30000)
      const values = current !== undefined && current.ok === true && current.value !== undefined && current.value.values !== undefined ? current.value.values : undefined
      if (values !== undefined && Array.isArray(values.turnOutline)) baseline = values.turnOutline.length
    }
    const requestId = 'hub-subagent-' + randomUUID()
    const prompted = await remoteRpc(host, 'session/prompt', {
      request: {
        requestId: requestId,
        sessionId: sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: options.task === undefined ? '' : String(options.task) }],
        clientTimeZone: options.clientTimeZone === undefined ? 'Asia/Shanghai' : options.clientTimeZone,
      },
    }, 30000)
    if (prompted === undefined || prompted.ok !== true) {
      detach()
      await cancelQuietly(remoteRpc, host, sessionId)
      throw new Error('remote session/prompt failed on ' + host.id)
    }
    const result = waitForTurn(remoteRpc, host, sessionId, {
      signal: controller.signal,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      baseline: baseline,
    }).then(function (outcome) {
      detach()
      const text = typeof outcome.text === 'string' ? outcome.text : ''
      return {
        output: text === '' ? [] : [{ type: 'text', text: text }],
        stopReason: outcome.stopReason,
        diagnostic: outcome.diagnostic,
      }
    })
    return {
      id: sessionId,
      result: result,
      dispose: function () {
        controller.abort()
        return cancelQuietly(remoteRpc, host, sessionId).then(function () { return result }).catch(function () {})
      },
    }
  } catch (error) {
    detach()
    throw error
  }
}

/** Native dsh subagent provider backed by one remote dsh host. */
export function createRemoteProvider(host, remoteRpc, options) {
  const defaults = options === undefined ? {} : options
  return {
    name: 'remote-dsh-' + host.id,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    inheritsParentContext: false,
    start: function (request) {
      return startRemoteSubagent(host, remoteRpc, {
        task: promptText(request.prompt),
        cwd: request.cwd,
        signal: request.signal,
        timeoutMs: defaults.timeoutMs,
        pollIntervalMs: defaults.pollIntervalMs,
      })
    },
  }
}
