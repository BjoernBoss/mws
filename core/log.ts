/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libFs from "fs";

export type LogLevel = 'error' | 'info' | 'warning' | 'log' | 'trace';

let LogListener: LogCallback[] = [ConsoleLogger()];
function MakeActualLog(level: LogLevel, identity: string, msg: string): void {
	const date: string = new Date().toUTCString();
	for (const log of LogListener)
		log(level, date, identity, msg);
}

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

const DEFAULT_FILE_FLUSHING_DELAY: number = 1_500;
const DEFAULT_FILE_BUF_MAXIMUM_LINES = 1_500;
const DEFAULT_FILE_SIZE_SWAP_FILE = 10_000_000;

export enum PreserveMode {
	/* simply clear the log file once full */
	none,

	/* preserve the last log file to 'filePath.old' */
	last,

	/* preserve all last log files to 'filePath.%time%.old */
	all
}

/* implementation of a file logger, which logs into the file-path and optionally preserves old logs */
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

/* implementation of a logger which receives a well formatted line */
export function LineLogger(cb: (line: string) => void): LogCallback {
	return (level: LogLevel | null, date: string, identity: string, msg: string) => {
		if (level != null)
			cb(FormatLine(level, date, identity, msg, false));
	};
}

/* remove all registered loggers (default logger is a single console logger) */
export function ClearLoggers(): void {
	for (const log of LogListener)
		log(null, '', '', '');
	LogListener = [];
}

/* register another logger to receive the logs */
export function AddLogger(cb: LogCallback): void {
	LogListener.push(cb);
}

export class LogIdentity {
	protected logIdentity: string;

	constructor(identity: string) {
		this.logIdentity = identity;
	}

	public error(msg: string): void {
		MakeActualLog('error', this.logIdentity, msg);
	}
	public info(msg: string): void {
		MakeActualLog('info', this.logIdentity, msg);
	}
	public warning(msg: string): void {
		MakeActualLog('warning', this.logIdentity, msg);
	}
	public log(msg: string): void {
		MakeActualLog('log', this.logIdentity, msg);
	}
	public trace(msg: string): void {
		MakeActualLog('trace', this.logIdentity, msg);
	}
}

export function Logger(identity: string): LogIdentity {
	return new LogIdentity(identity);
}
