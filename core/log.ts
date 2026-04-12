/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as libFs from "fs";

interface FileLoggingConfig {
	configured: boolean;
	logFilePath: string;
	oldFilePath: string;
	logFileSize: number;
	fs: null | number,
	buffer: string[];
	flushId: null | NodeJS.Timeout;
}
const FileFlushingDelay: number = 1_500;
const FileBufMaximumLines = 1_500;
const FileLoggingMaxLength = 10_000_000;

var logIntoConsole: boolean = true;
var logFile: FileLoggingConfig = {
	configured: false,
	logFilePath: '',
	oldFilePath: '',
	logFileSize: 0,
	fs: null,
	buffer: [],
	flushId: null
};

function FlushToFile(): void {
	if (logIntoConsole)
		console.log('flushing into file');

	/* write the buffer to the file */
	if (logFile.buffer.length > 0 && logFile.fs != null) {
		const content = Buffer.from(logFile.buffer.join(""), 'utf-8');
		try { libFs.writeFileSync(logFile.fs, content); } catch (err) { }
		logFile.logFileSize += content.length;
	}
	logFile.buffer = [];

	/* clear any currently queued flushes */
	if (logFile.flushId != null) {
		clearTimeout(logFile.flushId);
		logFile.flushId = null;
	}
}
function MakeActualLog(level: string, msg: string): void {
	const log = `[${new Date().toUTCString()}] ${level}: ${msg}`;

	/* check if the log should be written to the console */
	if (logIntoConsole)
		console.log(log);

	/* check if the log should be written to a file */
	if (!logFile.configured)
		return;

	/* write the log to the buffer and check if the data need to be flushed inplace, or if the flushing can be delayed */
	logFile.buffer.push(`${log}\n`);
	if (logFile.buffer.length >= FileBufMaximumLines)
		FlushToFile();
	else {
		if (logFile.flushId != null)
			clearTimeout(logFile.flushId);
		logFile.flushId = setTimeout(FlushToFile, FileFlushingDelay);
	}

	/* check if the log-files need to be swapped */
	if (logFile.logFileSize < FileLoggingMaxLength)
		return;

	/* flush the buffered entries */
	FlushToFile();

	/* close the current file */
	if (logFile.fs != null) {
		try { libFs.closeSync(logFile.fs); } catch (err) { }
		logFile.fs = null;
	}

	/* move it to the old-slot and open the new file */
	try { libFs.renameSync(logFile.logFilePath, logFile.oldFilePath); } catch (err) { }
	try { logFile.fs = libFs.openSync(logFile.logFilePath, 'w'); } catch (err) { }
	logFile.logFileSize = 0;
};

export function SetLogConsole(logConsole: boolean): void {
	logIntoConsole = logConsole;
}
export function SetFileLogging(filePath: string): void {
	/* check if a logging-file already exists */
	if (logFile.configured)
		return;
	logFile.configured = true;

	/* setup the two paths */
	logFile.logFilePath = `${filePath}.log`;
	logFile.oldFilePath = `${filePath}.old.log`;

	/* setup the logging state */
	try { logFile.fs = libFs.openSync(logFile.logFilePath, 'a'); } catch (err) { }
	try { logFile.logFileSize = libFs.fstatSync(logFile.fs as number).size; } catch (err) { }
}
export function Error(msg: string): void {
	MakeActualLog('Error', msg);
};
export function Info(msg: string): void {
	MakeActualLog('Info', msg);
};
export function Warning(msg: string): void {
	MakeActualLog('Warning', msg);
};
export function Log(msg: string): void {
	MakeActualLog('Log', msg);
};
