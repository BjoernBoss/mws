/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libFs from "fs";

const DEFAULT_FILE_FLUSHING_DELAY: number = 2_000;
const DEFAULT_FILE_BUF_MAXIMUM_LINES = 1_000;
const DEFAULT_FILE_SIZE_SWAP_FILE = 10_000_000;

const LoggerIdMap: Record<string, number> = {};
const GlobalLogConsumers: Set<LogConsumer> = new Set<LogConsumer>();

function formatLevel(level: LogLevel): string {
	switch (level) {
		case 'log':
			return 'Log  ';
		case 'trace':
			return 'Trace';
		case 'error':
			return 'Error';
		case 'info':
			return 'Info ';
		case 'warning':
			return 'Warn ';
	}
}
function formatLine(level: LogLevel, date: string, identity: string, msg: string, lineBreak: boolean): string {
	let printLevel: string = formatLevel(level);
	if (lineBreak)
		return `[${date}] ${printLevel}: [${identity}] ${msg}\n`;
	return `[${date}] ${printLevel}: [${identity}] ${msg}`;
}

/* supported log level */
export type LogLevel = 'error' | 'info' | 'warning' | 'log' | 'trace';

/* if [level] is null: is not a log, but the callback is being unregistered */
export type LogConsumer = (level: LogLevel | null, date: string, identity: string, msg: string) => void;

/* type to invoke to detach the given logger */
export type Detacher = () => void;

/* implementation of a console logger */
export function createConsoleLogger(): LogConsumer {
	return (level: LogLevel | null, date: string, identity: string, msg: string) => {
		if (level == null)
			return;
		let levelPrint: string = formatLevel(level);
		if (process.stdout?.hasColors == null || !process.stdout.hasColors())
			return console.log(formatLine(level, date, identity, msg, false));

		let levelColor = '';
		switch (level) {
			case 'log':
				levelColor = '\x1b[37m';
				break;
			case 'trace':
				levelColor = '\x1b[94m';
				break;
			case 'error':
				levelColor = '\x1b[31m';
				break;
			case 'info':
				levelColor = '\x1b[92m';
				break;
			case 'warning':
				levelColor = '\x1b[33m';
				break;
		}

		console.log(`\x1b[90m[${date}] ${levelColor}${levelPrint}\x1b[0m: [\x1b[93m${identity}\x1b[0m] ${msg}`);
	};
}

/* implementation of a logger which receives a well formatted line */
export function createLineLogger(cb: (line: string) => void): LogConsumer {
	return (level: LogLevel | null, date: string, identity: string, msg: string) => {
		if (level != null)
			cb(formatLine(level, date, identity, msg, false));
	};
}

/* file overwriting preservation mode */
export enum PreserveMode {
	/* simply clear the log file once full */
	none,

	/* preserve the last log file to 'filePath.old' */
	last,

	/* preserve all last log files to 'filePath.%time%.old */
	all
}

/* implementation of a file logger, which logs into the file-path and optionally preserves old logs
*	(Note: contains a timer, server shutdown should clear all loggers to ensure fast shutdown) */
export function createFileLogger(filePath: string, options?: { flushingDelayMs?: number, bufMaxLineCount?: number, sizeSwapFile?: number, preserve?: PreserveMode }): LogConsumer {
	/* setup the logging state (ignore any errors, as they cannot be logged) */
	let fileHandle: number | null = null;
	let logFileSize: number = 0;
	try {
		fileHandle = libFs.openSync(filePath, 'a');
		logFileSize = libFs.fstatSync(fileHandle).size;
	}
	catch (_) { }

	/* setup the file-flushing helper function */
	let logBuffer: string[] = [];
	let flushId: NodeJS.Timeout | null = null;
	const flushToFile = () => {
		/* write the buffer to the file */
		if (logBuffer.length > 0 && fileHandle != null) {
			const content = Buffer.from(logBuffer.join(""), 'utf-8');
			try { libFs.writeFileSync(fileHandle, content); } catch (_) { }
			logFileSize += content.length;
		}
		logBuffer = [];

		/* clear any currently queued flushes */
		if (flushId != null) {
			clearTimeout(flushId);
			flushId = null;
		}
	};
	const flushingDelayMs: number = (options?.flushingDelayMs == null ? DEFAULT_FILE_FLUSHING_DELAY : options.flushingDelayMs);
	const bufMaxLineCount: number = (options?.bufMaxLineCount == null ? DEFAULT_FILE_BUF_MAXIMUM_LINES : options.bufMaxLineCount);
	const sizeSwapFile: number = (options?.sizeSwapFile == null ? DEFAULT_FILE_SIZE_SWAP_FILE : options.sizeSwapFile);

	/* setup the actual closure handler */
	return (level: LogLevel | null, date: string, identity: string, msg: string) => {
		/* check if the logger is being disabled and reset the file state */
		if (level == null) {
			flushToFile();
			if (fileHandle != null)
				try { libFs.closeSync(fileHandle); } catch (_) { }
			fileHandle = null;
			return;
		}

		/* write the log to the buffer and check if the data need to be flushed inplace, or if the flushing can be delayed */
		logBuffer.push(formatLine(level, date, identity, msg, true));
		if (logBuffer.length >= bufMaxLineCount)
			flushToFile();
		else {
			if (flushId != null)
				clearTimeout(flushId);
			flushId = setTimeout(flushToFile, flushingDelayMs);
		}

		/* check if the log-files need to be swapped */
		if (logFileSize < sizeSwapFile)
			return;

		/* flush the buffered entries and close the current file */
		flushToFile();
		if (fileHandle != null) {
			try { libFs.closeSync(fileHandle); } catch (_) { }
			fileHandle = null;
		}

		/* preserve the old file to be used or remove it */
		if (options?.preserve == PreserveMode.all)
			try { libFs.renameSync(filePath, `${filePath}.${Date.now()}.old`); } catch (_) { }
		else if (options?.preserve == PreserveMode.last)
			try { libFs.renameSync(filePath, `${filePath}.old`); } catch (_) { }
		else
			try { libFs.unlinkSync(filePath); } catch (_) { }

		try { fileHandle = libFs.openSync(filePath, 'w'); } catch (_) { }
		logFileSize = 0;
	};
}

/* implementation of a log filter, which can filter by matching level and identity including a given sub-string, and then forwards these logs to the target logger */
export function createLogFilter(target: LogConsumer, options?: { level?: LogLevel | LogLevel[], identity?: string | string[] }): LogConsumer {
	const filterLevel = (options?.level == null ? null : new Set<string>(Array.isArray(options.level) ? options.level : [options.level]));
	const filterIdentity = (options?.identity == null ? null : (Array.isArray(options.identity) ? options.identity : [options.identity]));

	return (level: LogLevel | null, date: string, identity: string, msg: string) => {
		if (level == null)
			return target(null, '', '', '');

		/* check if the level is supported */
		if (filterLevel != null && !filterLevel.has(level))
			return;
		if (filterIdentity != null && !filterIdentity.some((value) => identity.includes(value)))
			return;
		target(level, date, identity, msg);
	};
}

/* logger class to extend, supporting various logging classes, and writing to the registered log consumer */
export function createLogger(identity: string): Logger {
	return new Logger(identity);
}
export class Logger {
	private _logIdentity: string;

	public constructor(identity: string) {
		const id = (LoggerIdMap[identity] ?? 0) + 1;
		LoggerIdMap[identity] = id;

		this._logIdentity = `${identity}!${id}`;
	}
	private _performActualLog(level: LogLevel, msg: string, options?: { identity?: string }): void {
		const identity = (options?.identity == null ? this._logIdentity : options.identity);
		logGlobal(level, identity, msg);
	}

	/* update the log identity */
	protected logSetIdentity(identity: string): void {
		this._logIdentity = identity;
	}

	/* logging identity as shown in logs */
	public get identity(): string {
		return this._logIdentity;
	}

	public error(msg: string, options?: { identity?: string }): void {
		this._performActualLog('error', msg, options);
	}
	public info(msg: string, options?: { identity?: string }): void {
		this._performActualLog('info', msg, options);
	}
	public warning(msg: string, options?: { identity?: string }): void {
		this._performActualLog('warning', msg, options);
	}
	public log(msg: string, options?: { identity?: string }): void {
		this._performActualLog('log', msg, options);
	}
	public trace(msg: string, options?: { identity?: string }): void {
		this._performActualLog('trace', msg, options);
	}
}

/* register another global logger to receive the logs (returned detacher can be invoked to remove the log) */
export function addLogger(cb: LogConsumer): Detacher {
	let detached = false;
	const wrapped = (level: LogLevel | null, date: string, identity: string, msg: string): void => {
		if (detached) return;

		if (level == null) {
			GlobalLogConsumers.delete(wrapped);
			detached = true;
		}

		try {
			if (detached)
				cb(null, '', '', '');
			else
				cb(level, date, identity, msg);
		}
		catch (err: any) {
			console.error(`Logger failed: ${err.message}`);
			wrapped(null, '', '', '');
		}
	};
	GlobalLogConsumers.add(wrapped);

	return () => {
		wrapped(null, '', '', '');
	};
}

/* perform a global log to all registered loggers */
export function logGlobal(level: LogLevel, identity: string, msg: string): void {
	const date = new Date().toUTCString();
	for (const cb of GlobalLogConsumers)
		cb(level, date, identity, msg);
}
