/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */

export class HtmlQueue {
	private page: HtmlPage;
	private queue: ((page: HtmlPage, done: () => void) => void)[];
	private completed?: (page: HtmlPage) => void;

	constructor() {
		this.page = new HtmlPage();
		this.queue = [];
	}

	private handleNext(): void {
		if (this.queue.length > 0) {
			this.queue[0](this.page, () => {
				this.queue.splice(0, 1);
				this.handleNext();
			});
		}
		else if (this.completed != undefined)
			this.completed(this.page);
	}

	public modify(cb: (page: HtmlPage, done: () => void) => void): void {
		if (this.queue.length == 0 && this.completed != undefined)
			throw new Error('Html queue already closed');
		this.queue.push(cb);
	}
	public process(cb: (page: HtmlPage) => void): void {
		if (this.completed != undefined)
			throw new Error('Html queue already being processed');
		this.completed = cb;
		this.handleNext();
	}
};

/*
*	Automatically configures the page to use utf-8
*	Defaults the language to be 'en'
*/
export class HtmlPage {
	public head: string;
	public body: string;
	public language: string;

	constructor(language: string = 'en') {
		this.head = '';
		this.body = '';
		this.language = language;
	}

	public finalize(): string {
		return `<!DOCTYPE html>
<html${this.language.length > 0 ? ` lang="${this.language}"` : ''} style="margin:0;height:100%;">
<head>
	<meta charset="utf-8">
${this.head}</head>
<body style="margin:0;height:100%;display:flex;">
${this.body}</body>
</html>
`;
	}
};

export function SingleTag(name: string, attributes: string = ''): string {
	return `\t<${name}${attributes.length == 0 ? '' : ` ${attributes}`}>\n`;
}
export function DualTag(name: string, attributes: string, body: string, short: boolean = false): string {
	if (body.length == 0 || short)
		return `\t<${name}${attributes.length == 0 ? '' : ` ${attributes}`}>${body}</${name}>\n`;
	return `\t<${name}${attributes.length == 0 ? '' : ` ${attributes}`}>\n${body}</${name}>\n`;
}
export function Meta(name: string, content: string): string {
	return SingleTag('meta', `name="${name}" content="${content}"`);
}
export function Title(name: string): string {
	return DualTag('title', '', name, true);
}
export function Text(text: string, attributes: string = ''): string {
	return DualTag('p', attributes, text, true);
}
export function LoadStyle(path: string): string {
	return SingleTag('link', `rel="stylesheet" type="text/css" href="${path}"`);
}
export function AddStyle(content: string): string {
	return DualTag('style', '', content, false);
}
export function LoadScript(path: string, attributes: string = ''): string {
	return DualTag('script', `src="${path}"${attributes.length == 0 ? '' : ` ${attributes}`}`, '', true);
}
export function AddScript(content: string): string {
	return DualTag('script', '', content, false);
}
export function Div(attributes: string, body: string): string {
	return DualTag('div', attributes, body);
}
export function LoadingError(): string {
	return Text('Failed to load Page Content', 'style="font-family: monospace; color: red; font-weight: bold; text-align: center;"');
}
