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
			const that = this;
			this.queue[0](this.page, function () {
				that.queue.splice(0, 1);
				that.handleNext();
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
	private head: string;
	private body: string;
	private language: string;

	constructor(language: string = 'en') {
		this.head = '';
		this.body = '';
		this.language = language;
	}

	public setLanguage(language: string): this {
		this.language = language;
		return this;
	}
	public addHead(content: string): this {
		this.head += `\n\t${content}`;
		return this;
	}
	public addBody(content: string): this {
		this.body += `\n\t${content}`;
		return this;
	}
	public wrapBody(wrap: (body: string) => string): this {
		this.body = wrap(this.body);
		return this;
	}
	public finalize(): string {
		return `<!DOCTYPE html>
<html${this.language.length > 0 ? ` lang="${this.language}"` : ''}>
<head>
	<meta charset="utf-8">${this.head}
</head>
<body>${this.body}
</body>
</html>
`;
	}
};

export function SingleTag(name: string, attributes: string = ''): string {
	return `<${name}${attributes.length == 0 ? '' : ` ${attributes}`}>`;
}
export function DualTag(name: string, attributes: string, body: string, short: boolean = false): string {
	if (body.length == 0 || short)
		return `<${name}${attributes.length == 0 ? '' : ` ${attributes}`}>${body}</${name}>`;
	return `<${name}${attributes.length == 0 ? '' : ` ${attributes}`}>\n\t${body}\n</${name}>`;
}
export function Meta(name: string, content: string): string {
	return SingleTag('meta', `name = "${name}" "content="${content}"`);
}
export function Title(name: string): string {
	return DualTag('title', '', name, true);
}
export function Text(text: string, attributes: string = ''): string {
	return DualTag('p', attributes, text, true);
}
export function StyleSheet(path: string): string {
	return SingleTag('link', `rel="stylesheet" type="text/css" href="${path}"`);
}
export function Script(path: string): string {
	return DualTag('script', `src="${path}"`, '', true);
}
export function Div(attributes: string): (body: string) => string {
	return (body: string) => DualTag('div', attributes, body);
}
export function LoadError(): string {
	return Text('Failed to load page content', 'style="font-family: monospace; color: red;"');
}
