/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libFs from "fs";

/* setup the initial default console-logger */
let LogListener: Set<LogCallback> = new Set<LogCallback>();
AddLogger(ConsoleLogger());

function MakeActualLog(level: LogLevel, identity: string, msg: string): void {
	const date: string = new Date().toUTCString();
	for (const log of LogListener)
		log(level, date, identity, msg);
}

export type LogLevel = 'error' | 'info' | 'warning' | 'log' | 'trace';

/* if [level] is null: is not a log, but the callback is being unregistered */
export type LogCallback = (level: LogLevel | null, date: string, identity: string, msg: string) => void;

/* format the parameter into a well known style */
export function FormatLevel(level: LogLevel): string {
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
export function FormatLine(level: LogLevel, date: string, identity: string, msg: string, lineBreak: boolean): string {
	let printLevel: string = FormatLevel(level);
	if (lineBreak)
		return `[${date}] ${printLevel}: [${identity}] ${msg}\n`;
	return `[${date}] ${printLevel}: [${identity}] ${msg}`;
}

/* implementation of a console logger */
export function ConsoleLogger(): LogCallback {
	return (level: LogLevel | null, date: string, identity: string, msg: string) => {
		if (level == null)
			return;
		let levelPrint: string = FormatLevel(level);
		if (process.stdout?.hasColors == null || !process.stdout.hasColors())
			return console.log(FormatLine(level, date, identity, msg, false));

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
export function LineLogger(cb: (line: string) => void): LogCallback {
	return (level: LogLevel | null, date: string, identity: string, msg: string) => {
		if (level != null)
			cb(FormatLine(level, date, identity, msg, false));
	};
}

const DEFAULT_FILE_FLUSHING_DELAY: number = 2_000;
const DEFAULT_FILE_BUF_MAXIMUM_LINES = 1_000;
const DEFAULT_FILE_SIZE_SWAP_FILE = 10_000_000;

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
export function FileLogger(filePath: string, options?: { flushingDelayMs?: number, bufMaxLineCount?: number, sizeSwapFile?: number, preserve?: PreserveMode }): LogCallback {
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
		logBuffer.push(FormatLine(level, date, identity, msg, true));
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

/* remove all registered loggers (default logger is a single console logger) */
export function ClearLoggers(): void {
	for (const log of LogListener)
		log(null, '', '', '');
}

/* type to invoke to detach the given logger */
export type Detacher = () => void;

/* register another logger to receive the logs (returned detacher can be invoked to remove the log) */
export function AddLogger(cb: LogCallback): Detacher {
	let detached = false;
	const wrapped = (level: LogLevel | null, date: string, identity: string, msg: string): void => {
		if (detached) return;

		if (level == null) {
			LogListener.delete(wrapped);
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
	LogListener.add(wrapped);

	return () => {
		wrapped(null, '', '', '');
	};
}

const LoggerIdMap: Record<string, number> = {};

/* type to invoke to update the logging tag (empty string will hide the tag entry;
*	null will completely remove the tag; other values will update the tag) */
export type TagUpdate = (value?: string) => void;

/* logger class to extend, supporting various logging classes */
export class Logger {
	private _rootIdentity: string;
	private _logIdentity: string;
	private _logTagList: { value: string }[];

	constructor(identity: string) {
		const id = (LoggerIdMap[identity] ?? 0) + 1;
		LoggerIdMap[identity] = id;

		this._rootIdentity = `${identity}!${id}`;
		this._logIdentity = this._rootIdentity;
		this._logTagList = [];
	}
	private _updateLogIdentity(): void {
		this._logIdentity = this._rootIdentity;

		for (const tag of this._logTagList) {
			if (tag.value != '')
				this._logIdentity += `.${tag.value}`;
		}
	}

	/* root identity tagged with unique id */
	public get logRoot(): string {
		return this._rootIdentity;
	}

	/* tag extension appended to root identity to form full logging identity */
	public get logExtension(): string {
		return this._logIdentity.substring(this._rootIdentity.length + 1);
	}

	/* full logging identity as shown in logs */
	public get logIdentity(): string {
		return this._logIdentity;
	}

	/* tag the logging with the given identifier and return a callback to update the tag */
	public tagLog(identifier: string): TagUpdate {
		let tag: { value: string } | null = { value: identifier };

		this._logTagList.push(tag);
		if (tag.value != '')
			this._updateLogIdentity();

		/* setup the handler responsible to update the logging */
		return (value?: string) => {
			if (tag == null) return;

			/* check if the tag should be removed or if the value should just be updated */
			if (value == null) {
				this._logTagList = this._logTagList.filter((v) => v != tag);
				tag = null;
			}
			else if (value != tag.value)
				tag.value = value;

			this._updateLogIdentity();
		};
	}

	public error(msg: string): void {
		MakeActualLog('error', this._logIdentity, msg);
	}
	public info(msg: string): void {
		MakeActualLog('info', this._logIdentity, msg);
	}
	public warning(msg: string): void {
		MakeActualLog('warning', this._logIdentity, msg);
	}
	public log(msg: string): void {
		MakeActualLog('log', this._logIdentity, msg);
	}
	public trace(msg: string): void {
		MakeActualLog('trace', this._logIdentity, msg);
	}
}

/* create a logger class to create associated logs */
export function MakeLogger(identity: string): Logger {
	return new Logger(identity);
}
