/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */

enum BuilderState {
	none,
	content,
	full
}

export class HtmlBuilder {
	private state: BuilderState;
	private header: string;
	private content: string;
	private bodyPrefix: string;
	private bodySuffix: string;
	private title?: string;
	private language?: string;

	constructor() {
		this.state = BuilderState.none;
		this.header = '';
		this.content = '';
		this.bodyPrefix = '';
		this.bodySuffix = '';
		this.title = '';
		this.language = '';
	}

	public addHeader(line: string): void {
		this.header += `${line}\n\t`;
	}
	public setFullDocument(fullDocument: string): void {
		if (this.state != BuilderState.none)
			throw new Error('Html document with multiple contents');
		this.content = fullDocument;
		this.state = BuilderState.full;
	}

	/* language defaults to 'en' if empty */
	public setContent(body: string, config: { title?: string, language?: string }): void {
		if (this.state != BuilderState.none)
			throw new Error('Html document with multiple contents');
		this.state = BuilderState.content;
		this.content = body;
		this.title = config.title;
		this.language = (config.language == undefined ? 'en' : config.language);
	}
	public wrap(prefix: string, suffix: string): void {
		if (prefix.length > 0)
			this.bodyPrefix = `${prefix}\n${this.bodyPrefix}`;
		if (suffix.length > 0)
			this.bodySuffix = `${this.bodySuffix}\n${suffix}`;
	}
	public finalize(): string {
		if (this.state == BuilderState.none)
			throw new Error('Html document with no content');
		if (this.state == BuilderState.full)
			return this.content;

		/* construct the full final document */
		return `<!DOCTYPE html>
<html${(this.language ? ` lang="${this.language}"` : '')}>

<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	${this.header}${(this.title ? `<title>${this.title}</title>\n` : '')}</head>

<body>
${this.bodyPrefix}${this.content}${this.bodySuffix}
</body>

</html>
`;
	}
};
