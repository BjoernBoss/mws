/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libFs from "fs";

export type LogLevel = 'error' | 'info' | 'warning' | 'log' | 'trace';

let LogListener: LogCallback[] = [ConsoleLogger()];
function MakeActualLog(level: LogLevel, msg: string): void {
	const date: string = new Date().toUTCString();
	for (const log of LogListener)
		log(level, date, msg);
}

/* if [level] is null: is not a log, but the callback is being unregistered */
export type LogCallback = (level: LogLevel | null, date: string, msg: string) => void;

/* format the parameter into a well known style */
export function FormatLine(level: LogLevel, date: string, msg: string, lineBreak: boolean): string {
	let printLevel: string = '';
	switch (level) {
		case 'log':
			printLevel = 'Log  ';
			break;
		case 'trace':
			printLevel = 'Trace';
			break;
		case 'error':
			printLevel = 'Error';
			break;
		case 'info':
			printLevel = 'Info ';
			break;
		case 'warning':
			printLevel = 'Warn ';
			break;
	}
	if (lineBreak)
		return `[${date}] ${printLevel}: ${msg}\n`;
	return `[${date}] ${printLevel}: ${msg}`;
}

/* implementation of a console logger */
export function ConsoleLogger(): LogCallback {
	return (level: LogLevel | null, date: string, msg: string) => {
		if (level != null)
			console.log(FormatLine(level, date, msg, false));
	};
}

const DEFAULT_FILE_FLUSHING_DELAY: number = 1_500;
const DEFAULT_FILE_BUF_MAXIMUM_LINES = 1_500;
const DEFAULT_FILE_SIZE_SWAP_FILE = 10_000_000;

/* implementation of a file logger, which logs into the file-path and preserves into filePath + '.old' */
export function FileLogger(filePath: string, options?: { flushingDelayMs?: number, bufMaxLineCount?: number, sizeSwapFile?: number }): LogCallback {
	/* setup the two paths */
	const logFilePath: string = filePath;
	const oldFilePath: string = `${filePath}.log`;

	/* setup the logging state (ignore any errors, as they cannot be logged) */
	let fileHandle: number | null = null;
	let logFileSize: number = 0;
	try {
		fileHandle = libFs.openSync(logFilePath, 'a');
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
	return (level: LogLevel | null, date: string, msg: string) => {
		/* check if the logger is being disabled and clear  */
		if (level == null) {
			flushToFile();
			if (fileHandle != null)
				try { libFs.closeSync(fileHandle); } catch (_) { }
			fileHandle = null;
			return;
		}

		/* write the log to the buffer and check if the data need to be flushed inplace, or if the flushing can be delayed */
		logBuffer.push(`${FormatLine(level, date, msg, true)}\n`);
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

		/* flush the buffered entries */
		flushToFile();

		/* close the current file */
		if (fileHandle != null) {
			try { libFs.closeSync(fileHandle); } catch (_) { }
			fileHandle = null;
		}

		/* move it to the old-slot and open the new file */
		try { libFs.renameSync(logFilePath, oldFilePath); } catch (_) { }
		try { fileHandle = libFs.openSync(logFilePath, 'w'); } catch (_) { }
		logFileSize = 0;
	};
}

/* implementation of a logger which receives a well formatted line */
export function LineLogger(cb: (line: string) => void): LogCallback {
	return (level: LogLevel | null, date: string, msg: string) => {
		if (level != null)
			cb(FormatLine(level, date, msg, false));
	};
}

/* remove all registered loggers (default logger is a single console logger) */
export function ClearLoggers(): void {
	for (const log of LogListener)
		log(null, '', '');
	LogListener = [];
}

/* register another logger to receive the logs */
export function AddLogger(cb: LogCallback): void {
	LogListener.push(cb);
}

export function Error(msg: string): void {
	MakeActualLog('error', msg);
}
export function Info(msg: string): void {
	MakeActualLog('info', msg);
}
export function Warning(msg: string): void {
	MakeActualLog('warning', msg);
}
export function Log(msg: string): void {
	MakeActualLog('log', msg);
}
export function Trace(msg: string): void {
	MakeActualLog('trace', msg);
}

/* wrapper to offset all logs */
export class LogModule {
	private identity: string;

	constructor(identity: string) {
		this.identity = identity;
	}

	public Error(msg: string): void {
		Error(`{${this.identity}} ${msg}`);
	}
	public Info(msg: string): void {
		Error(`{${this.identity}} ${msg}`);
	}
	public Warning(msg: string): void {
		Error(`{${this.identity}} ${msg}`);
	}
	public Log(msg: string): void {
		Error(`{${this.identity}} ${msg}`);
	}
	public Trace(msg: string): void {
		Trace(`{${this.identity}} ${msg}`);
	}
}
