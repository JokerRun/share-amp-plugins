// @i-know-the-amp-plugin-api-is-wip-and-very-experimental-right-now
import type { AgentEndEvent, PluginAPI, PluginEventContext } from '@ampcode/plugin'

declare const require: (id: string) => any

const PLUGIN_NAME = 'amp-notify'

type TerminalState = {
	iterm: boolean
	tmux: boolean
	tmuxEnv?: string
	tmuxSocketPath?: string
	tmuxPane?: string
}

type ExecutorKind = PluginEventContext['system']['executor']['kind']
type NotificationText = {
	title: string
	subtitle: string
	message: string
}

let loggedUnsupportedRuntime = false
let loggedUnsupportedTerminal = false
let loggedMissingTTY = false

function requiredModules() {
	const childProcess = require('node:child_process') as typeof import('node:child_process')
	const fs = require('node:fs') as typeof import('node:fs')
	const path = require('node:path') as typeof import('node:path')
	const processModule = require('node:process') as typeof import('node:process')
	return { childProcess, fs, path, processModule }
}

function summarizeText(input: string, maxLength = 160): string {
	const normalized = input.replace(/\s+/gu, ' ').trim()
	if (normalized.length <= maxLength) {
		return normalized
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`
}

export function resolveWorkspaceRoot(cwd: string): string {
	const { path } = requiredModules()
	const normalized = path.resolve(cwd)
	if (path.basename(normalized) === 'plugins' && path.basename(path.dirname(normalized)) === '.amp') {
		return path.dirname(path.dirname(normalized))
	}
	return normalized
}

function isGlobalPluginDir(cwd: string): boolean {
	const { path } = requiredModules()
	const normalized = path.resolve(cwd)
	return (
		path.basename(normalized) === 'plugins' &&
		path.basename(path.dirname(normalized)) === 'amp' &&
		path.basename(path.dirname(path.dirname(normalized))) === '.config'
	)
}

export function deriveProjectName(cwd: string, pwdFromEnv?: string): string {
	const { path } = requiredModules()
	const resolvedCwd = resolveWorkspaceRoot(cwd)
	const resolvedPwd = pwdFromEnv ? path.resolve(pwdFromEnv) : undefined
	const preferredPath = isGlobalPluginDir(resolvedCwd) && resolvedPwd ? resolvedPwd : resolvedCwd
	return path.basename(preferredPath) || preferredPath
}

export function supportsNativeNotifications(executorKind: ExecutorKind): boolean {
	return executorKind !== 'remote'
}

function detectProjectName(): string {
	const { processModule } = requiredModules()
	return deriveProjectName(processModule.cwd(), processModule.env.PWD)
}

function readParentProcessEnv(name: 'TMUX' | 'TMUX_PANE'): string | undefined {
	const { childProcess, processModule } = requiredModules()
	const result = childProcess.spawnSync('ps', ['eww', '-o', 'command=', '-p', String(processModule.ppid)], {
		encoding: 'utf8',
	})
	if ((result.status ?? 1) !== 0) {
		return undefined
	}

	const match = result.stdout.match(new RegExp(`(?:^|\\s)${name}=([^\\s]+)`))
	return match?.[1]?.trim() || undefined
}

function processInfo(pid: number): { ppid: number; command: string } | undefined {
	const { childProcess } = requiredModules()
	const result = childProcess.spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
		encoding: 'utf8',
	})
	if ((result.status ?? 1) !== 0) {
		return undefined
	}

	const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/)
	if (!match) {
		return undefined
	}

	return {
		ppid: Number(match[1]),
		command: match[2].trim(),
	}
}

function ancestorShellPID(): number | undefined {
	const { processModule } = requiredModules()
	let pid = processModule.ppid
	for (let depth = 0; depth < 8 && pid > 1; depth += 1) {
		const info = processInfo(pid)
		if (!info) {
			return undefined
		}
		const command = info.command.split('/').pop()?.replace(/^-/, '') || info.command
		if (command === 'zsh' || command === 'bash' || command === 'fish' || command === 'sh' || command === 'nu') {
			return pid
		}
		pid = info.ppid
	}
	return undefined
}

function tmuxPaneFromProcessTree(): { pane?: string; socketPath?: string } {
	const { childProcess } = requiredModules()
	const shellPID = ancestorShellPID()
	if (!shellPID) {
		return {}
	}

	const panes = childProcess.spawnSync('tmux', ['list-panes', '-a', '-F', '#{pane_pid}\t#{pane_id}\t#{socket_path}'], {
		encoding: 'utf8',
	})
	if ((panes.status ?? 1) !== 0) {
		return {}
	}

	for (const line of panes.stdout.split('\n')) {
		const [panePID, pane, socketPath] = line.trim().split('\t')
		if (Number(panePID) === shellPID && pane) {
			return { pane, socketPath }
		}
	}

	return {}
}

function detectTerminal(): TerminalState {
	const { processModule } = requiredModules()
	const env = processModule.env
	const termProgram = env.TERM_PROGRAM?.trim() || undefined
	const iTermSessionID = env.ITERM_SESSION_ID?.trim() || undefined
	const termSessionID = env.TERM_SESSION_ID?.trim() || undefined
	const tmuxEnv = env.TMUX?.trim() || readParentProcessEnv('TMUX')
	const tmuxFallback = tmuxPaneFromProcessTree()
	const tmuxSocketPath = tmuxEnv?.split(',', 1)[0]?.trim() || tmuxFallback.socketPath
	const tmuxPane = env.TMUX_PANE?.trim() || readParentProcessEnv('TMUX_PANE') || tmuxFallback.pane
	const tmux = Boolean(tmuxEnv || tmuxPane || termProgram === 'tmux')

	return {
		iterm: Boolean(iTermSessionID || termSessionID?.startsWith('w')),
		tmux,
		tmuxEnv,
		tmuxSocketPath,
		tmuxPane,
	}
}

function lastAssistantText(event: AgentEndEvent): string | undefined {
	for (let index = event.messages.length - 1; index >= 0; index -= 1) {
		const message = event.messages[index]
		if (message.role !== 'assistant') {
			continue
		}
		const text = message.content
			.filter(block => block.type === 'text')
			.map(block => block.text)
			.join(' ')
		if (text.trim()) {
			return summarizeText(text, 220)
		}
	}
	return undefined
}

function lastUserText(event: Pick<AgentEndEvent, 'message' | 'messages'>): string | undefined {
	for (let index = event.messages.length - 1; index >= 0; index -= 1) {
		const message = event.messages[index]
		if (message.role !== 'user') {
			continue
		}
		const text = message.content
			.filter(block => block.type === 'text')
			.map(block => block.text)
			.join(' ')
			.trim()
		if (text) {
			return text
		}
	}
	return event.message.trim() || undefined
}

function statusLabel(status: AgentEndEvent['status']): string {
	if (status === 'error') {
		return 'Error'
	}
	if (status === 'interrupted') {
		return 'Interrupted'
	}
	return 'Done'
}

function tmuxCommandArgs(terminal: TerminalState, args: string[]): string[] {
	const socketPath = terminal.tmuxSocketPath?.trim() || terminal.tmuxEnv?.split(',', 1)[0]?.trim()
	return socketPath ? ['-S', socketPath, ...args] : args
}

function tmuxPaneTTY(terminal: TerminalState): string | undefined {
	const pane = terminal.tmuxPane?.trim()
	if (!pane) {
		return undefined
	}

	const { childProcess } = requiredModules()
	const result = childProcess.spawnSync(
		'tmux',
		tmuxCommandArgs(terminal, ['display-message', '-p', '-t', pane, '#{pane_tty}']),
		{ encoding: 'utf8' },
	)
	if ((result.status ?? 1) !== 0) {
		return undefined
	}

	const ttyPath = result.stdout.trim()
	return ttyPath || undefined
}

function terminalTTYFromProcessTree(): string | undefined {
	const shellPID = ancestorShellPID()
	if (!shellPID) {
		return undefined
	}

	const { childProcess } = requiredModules()
	const result = childProcess.spawnSync('ps', ['-o', 'tty=', '-p', String(shellPID)], { encoding: 'utf8' })
	if ((result.status ?? 1) !== 0) {
		return undefined
	}

	const ttyName = result.stdout.trim()
	if (!ttyName || ttyName === '?') {
		return undefined
	}

	return ttyName.startsWith('/dev/') ? ttyName : `/dev/${ttyName}`
}

function notificationTTY(terminal: TerminalState): string | undefined {
	if (terminal.tmux) {
		return tmuxPaneTTY(terminal)
	}
	return terminalTTYFromProcessTree()
}

export function buildNotificationText(
	event: Pick<AgentEndEvent, 'message' | 'messages' | 'status'>,
	projectName: string,
): NotificationText {
	const label = statusLabel(event.status)
	return {
		title: `Amp ${label}`,
		subtitle: `${projectName} · ${label}`,
		message: lastUserText(event) || lastAssistantText(event as AgentEndEvent) || `Amp ${label}`,
	}
}

export function buildOSC9Notification(text: NotificationText): string {
	const message = text.message.trim()
	const subtitle = text.subtitle.trim()
	if (!message && !subtitle) {
		return 'Amp'
	}

	const projectName = subtitle.split('·', 1)[0]?.trim()
	if (projectName && message) {
		return `${projectName}: ${message}`
	}

	return message || subtitle || text.title.trim() || 'Amp'
}

export function buildOSC9Payload(message: string, tmux: boolean): string {
	const sanitized = message.replace(/[\u0007\u001b]/gu, ' ').trim() || 'Amp'
	const rawPayload = `\u001b]9;${sanitized}\u0007`
	return tmux ? `\u001bPtmux;\u001b${rawPayload}\u001b\\` : rawPayload
}

function shouldNotify(ctx: PluginEventContext, terminal: TerminalState, ttyPath?: string): boolean {
	const { processModule } = requiredModules()
	if (!supportsNativeNotifications(ctx.system.executor.kind)) {
		if (!loggedUnsupportedRuntime) {
			loggedUnsupportedRuntime = true
			ctx.logger.log(
				`[${PLUGIN_NAME}] skipping notifications because executor is ${ctx.system.executor.kind}.`,
			)
		}
		return false
	}

	if (processModule.platform !== 'darwin') {
		if (!loggedUnsupportedRuntime) {
			loggedUnsupportedRuntime = true
			ctx.logger.log(`[${PLUGIN_NAME}] skipping notifications because platform is ${processModule.platform}.`)
		}
		return false
	}

	if (!terminal.iterm) {
		if (!loggedUnsupportedTerminal) {
			loggedUnsupportedTerminal = true
			ctx.logger.log(`[${PLUGIN_NAME}] skipping notifications because terminal is not iTerm2.`)
		}
		return false
	}

	if (!ttyPath) {
		if (!loggedMissingTTY) {
			loggedMissingTTY = true
			ctx.logger.log(`[${PLUGIN_NAME}] skipping notifications because no terminal TTY was detected.`)
		}
		return false
	}

	return true
}

function sendNativeNotification(event: AgentEndEvent, ctx: PluginEventContext): void {
	const projectName = detectProjectName()
	const terminal = detectTerminal()
	const ttyPath = notificationTTY(terminal)
	if (!shouldNotify(ctx, terminal, ttyPath)) {
		return
	}

	const { fs } = requiredModules()
	const text = buildNotificationText(event, projectName)
	const payload = buildOSC9Payload(buildOSC9Notification(text), terminal.tmux)

	try {
		fs.appendFileSync(ttyPath, payload, { encoding: 'utf8' })
	} catch (error) {
		ctx.logger.log(
			`[${PLUGIN_NAME}] failed to write OSC 9 notification to ${ttyPath}:`,
			error instanceof Error ? error.message : String(error),
		)
		return
	}

	ctx.logger.log(`[${PLUGIN_NAME}] notified ${event.status} for ${projectName} via OSC 9 (${ttyPath})`)
}

export default function (amp: PluginAPI): void {
	amp.on('agent.end', async (event, ctx) => {
		sendNativeNotification(event, ctx)
	})
}
