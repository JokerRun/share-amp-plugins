// @i-know-the-amp-plugin-api-is-wip-and-very-experimental-right-now
import type { PluginAPI, PluginCommandContext, PluginEventContext } from '@ampcode/plugin'

declare const require: (id: string) => any

const SUMMARY_INTERVAL_MS = 10 * 60 * 1000
const MIN_DELTA_FOR_SUMMARY = 0.25
const FREE_THRESHOLDS = [8, 5, 2, 1]

type RefreshContext = {
	ui: PluginEventContext['ui']
	logger: PluginEventContext['logger']
}

type UsageSnapshot = {
	summary: string
	freeRemaining?: number
	freeTotal?: number
	individualRemaining?: number
	rawOutput: string
}

let lastSnapshot: UsageSnapshot | undefined
let lastSummaryNotificationAt = 0
let notifiedFreeThresholds = new Set<number>()
let notifiedIndividualBelowZero = false
let inflight: Promise<void> | undefined

function stripLinkSuffix(line: string): string {
	return line.replace(/\s+-\s+https?:\/\/\S+/gu, '').trim()
}

function parseFreeLine(line: string): { remaining?: number; total?: number } {
	const match = line.match(/\$(-?\d+(?:\.\d+)?)\/\$(\d+(?:\.\d+)?)\s+remaining/u)
	if (!match) {
		return {}
	}

	return {
		remaining: Number(match[1]),
		total: Number(match[2]),
	}
}

function parseIndividualLine(line: string): { remaining?: number } {
	const match = line.match(/\$(-?\d+(?:\.\d+)?)\s+remaining/u)
	if (!match) {
		return {}
	}

	return { remaining: Number(match[1]) }
}

function parseUsage(stdout: string): UsageSnapshot {
	const lines = stdout
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean)

	const freeLine = lines.find(line => line.startsWith('Amp Free:'))
	const individualLine = lines.find(line => line.startsWith('Individual credits:'))

	const freeParsed = freeLine ? parseFreeLine(freeLine) : {}
	const individualParsed = individualLine ? parseIndividualLine(individualLine) : {}

	const parts: string[] = []
	if (freeParsed.remaining !== undefined && freeParsed.total !== undefined) {
		parts.push(`Free $${freeParsed.remaining.toFixed(2)}/$${freeParsed.total.toFixed(2)}`)
	} else if (freeLine) {
		parts.push(stripLinkSuffix(freeLine).replace('Amp Free:', 'Free').trim())
	}

	if (individualParsed.remaining !== undefined) {
		parts.push(`Individual $${individualParsed.remaining.toFixed(2)}`)
	} else if (individualLine) {
		parts.push(stripLinkSuffix(individualLine).replace('Individual credits:', 'Individual').trim())
	}

	const fallback = lines
		.filter(line => !line.startsWith('Signed in as'))
		.map(stripLinkSuffix)
		.filter(Boolean)
		.join(' | ')

	return {
		summary: parts.length > 0 ? `Amp usage: ${parts.join(' | ')}` : `Amp usage: ${fallback || 'unavailable'}`,
		freeRemaining: freeParsed.remaining,
		freeTotal: freeParsed.total,
		individualRemaining: individualParsed.remaining,
		rawOutput: stdout,
	}
}

function changedMeaningfully(prev: UsageSnapshot | undefined, next: UsageSnapshot): boolean {
	if (!prev) {
		return true
	}

	if (
		prev.freeRemaining !== undefined &&
		next.freeRemaining !== undefined &&
		Math.abs(next.freeRemaining - prev.freeRemaining) >= MIN_DELTA_FOR_SUMMARY
	) {
		return true
	}

	if (
		prev.individualRemaining !== undefined &&
		next.individualRemaining !== undefined &&
		Math.abs(next.individualRemaining - prev.individualRemaining) >= MIN_DELTA_FOR_SUMMARY
	) {
		return true
	}

	return prev.summary !== next.summary
}

function collectAlerts(prev: UsageSnapshot | undefined, next: UsageSnapshot): string[] {
	const alerts: string[] = []

	if (next.freeRemaining !== undefined) {
		for (const threshold of FREE_THRESHOLDS) {
			const crossed =
				(prev?.freeRemaining === undefined && next.freeRemaining <= threshold) ||
				(prev?.freeRemaining !== undefined && prev.freeRemaining > threshold && next.freeRemaining <= threshold)

			if (crossed && !notifiedFreeThresholds.has(threshold)) {
				notifiedFreeThresholds.add(threshold)
				alerts.push(`Amp Free crossed below $${threshold.toFixed(2)} (now $${next.freeRemaining.toFixed(2)}).`)
			}
		}
	}

	if (next.individualRemaining !== undefined && next.individualRemaining < 0) {
		const crossedZero = prev?.individualRemaining === undefined || prev.individualRemaining >= 0
		if (crossedZero && !notifiedIndividualBelowZero) {
			notifiedIndividualBelowZero = true
			alerts.push(`Individual credits are negative (now $${next.individualRemaining.toFixed(2)}).`)
		}
	}

	return alerts
}

async function fetchUsageSnapshot(): Promise<UsageSnapshot> {
	const { spawnSync } = require('node:child_process') as {
		spawnSync: (
			command: string,
			args: string[],
			options: { encoding: 'utf8'; env: Record<string, string> },
		) => { status: number | null; stdout?: string; stderr?: string }
	}
	const { homedir } = require('node:os') as { homedir: () => string }
	const processModule = require('node:process') as { env: Record<string, string | undefined> }
	const homeDir = homedir()
	const env: Record<string, string> = {
		HOME: homeDir,
		PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${homeDir}/.amp/bin:${homeDir}/.local/bin`,
		XDG_CONFIG_HOME: `${homeDir}/.config`,
		XDG_CACHE_HOME: `${homeDir}/.cache`,
	}
	if (processModule.env.AMP_URL) {
		env.AMP_URL = processModule.env.AMP_URL
	}
	for (const [key, value] of Object.entries(processModule.env)) {
		if (!key.startsWith('AMP_') || key === 'PLUGINS' || value === undefined) {
			continue
		}
		env[key] = value
	}
	env.PLUGINS = ''

	let result = spawnSync(`${homeDir}/.amp/bin/amp`, ['usage', '--no-color'], {
		encoding: 'utf8',
		env,
	})

	if ((result.status ?? 1) !== 0) {
		result = spawnSync('amp', ['usage', '--no-color'], {
			encoding: 'utf8',
			env,
		})
	}

	const exitCode = result.status ?? 1
	if (exitCode !== 0) {
		const stderr = result.stderr ?? ''
		const stdout = result.stdout ?? ''
		const details = stderr.trim() || stdout.trim() || `exit code ${exitCode}`
		throw new Error(`amp usage failed: ${details}`)
	}

	return parseUsage(result.stdout ?? result.stderr ?? '')
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}

async function refreshUsage(
	ctx: RefreshContext,
	reason: string,
	options?: { forceSummary?: boolean; notifyOnError?: boolean },
): Promise<void> {
	if (inflight) {
		await inflight
		return
	}

	inflight = (async () => {
		try {
			const snapshot = await fetchUsageSnapshot()
			const now = Date.now()
			const alerts = collectAlerts(lastSnapshot, snapshot)

			const shouldNotifySummary =
				options?.forceSummary === true ||
				reason === 'session.start' ||
				(now - lastSummaryNotificationAt >= SUMMARY_INTERVAL_MS && changedMeaningfully(lastSnapshot, snapshot))

			if (alerts.length > 0) {
				await ctx.ui.notify(`${alerts.join(' ')} ${snapshot.summary}`)
				lastSummaryNotificationAt = now
			} else if (shouldNotifySummary) {
				await ctx.ui.notify(snapshot.summary)
				lastSummaryNotificationAt = now
			}

			ctx.logger.log(`[usage-monitor] refreshed (${reason}): ${snapshot.summary}`)
			lastSnapshot = snapshot
		} catch (error) {
			ctx.logger.log(`[usage-monitor] refresh failed (${reason}):`, error)
			if (options?.notifyOnError) {
				await ctx.ui.notify(`usage-monitor refresh failed: ${formatError(error)}`)
			}
		}
	})()

	try {
		await inflight
	} finally {
		inflight = undefined
	}
}

function settingsURL(baseURL: URL): URL {
	return new URL('/settings', baseURL)
}

export default function (amp: PluginAPI): void {
	amp.on('session.start', async (_event, ctx) => {
		await refreshUsage({ ui: ctx.ui, logger: ctx.logger }, 'session.start')
	})

	amp.on('agent.end', async (_event, ctx) => {
		await refreshUsage({ ui: ctx.ui, logger: ctx.logger }, 'agent.end')
	})

	amp.registerCommand(
		'usage-monitor-show',
		{
			category: 'Usage Monitor',
			title: 'Show usage now',
			description: 'Fetch and show current Amp usage and remaining balance.',
		},
		async (ctx: PluginCommandContext) => {
			await refreshUsage({ ui: ctx.ui, logger: amp.logger }, 'manual.show', {
				forceSummary: true,
				notifyOnError: true,
			})
		},
	)

	amp.registerCommand(
		'usage-monitor-open-settings',
		{
			category: 'Usage Monitor',
			title: 'Open usage settings',
			description: 'Open Amp settings page for detailed balance and billing info.',
		},
		async (ctx: PluginCommandContext) => {
			await ctx.system.open(settingsURL(ctx.system.ampURL))
		},
	)
}
