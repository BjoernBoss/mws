/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */

/* escape all html-special characters to prevent injection when embedding untrusted values */
export function EscapeHtml(content: string): string {
	let out = '';
	for (let i = 0; i < content.length; ++i) {
		switch (content[i]) {
			case '&': out += '&amp;'; break;
			case '<': out += '&lt;'; break;
			case '>': out += '&gt;'; break;
			case '"': out += '&quot;'; break;
			case '\'': out += '&#39;'; break;
			default: out += content[i]; break;
		}
	}
	return out;
}

/* wrapper around a string that has been verified as safe for direct html insertion;
*	plain strings are treated as untrusted and will be html-escaped before wrapping */
export type HtmlString = HtmlGuard | string;
export class HtmlGuard {
	public content: string;
	private constructor(content: string) {
		this.content = content;
	}

	/* ensure the value is safe for html insertion; escapes plain strings, passes through HtmlGuard as-is */
	public static get(str: HtmlString): HtmlGuard {
		return (str instanceof HtmlGuard ? str : new HtmlGuard(EscapeHtml(str)));
	}

	/* wrap a string for html insertion; if safe is false, it will be html-escaped first */
	public static make(str: string, safe: boolean = true): HtmlGuard {
		return new HtmlGuard(safe ? str : EscapeHtml(str));
	}
}

/* create a secure string [if safe is true, content is taken as-is; otherwise it is html escaped] */
export function Safe(content: string, safe: boolean = true): HtmlGuard {
	return HtmlGuard.make(content, safe);
}

export interface HtmlComponent {
	finalize(indent: string): string;
	simple(): boolean;
}

/* raw text content to be embedded into an html tree */
export class EmbeddedContent implements HtmlComponent {
	private content: string;
	public constructor(content: string, safe: boolean) {
		this.content = (safe ? content : EscapeHtml(content));
	}
	public simple(): boolean {
		return (this.content.indexOf('\n') < 0);
	}
	public finalize(_: string): string {
		return this.content;
	}
}

/* self-closing html tag (e.g. <meta/>, <link/>, <br/>) */
export class SingleTag implements HtmlComponent {
	private content: string;
	public constructor(name: string, properties: Record<string, HtmlString> = {}) {
		let details = '';
		for (const name in properties)
			details += ` ${name}="${HtmlGuard.get(properties[name]).content}"`;

		this.content = `<${name}${details}/>`;
	}
	public simple(): boolean { return false; }
	public finalize(indent: string): string {
		return `${indent}${this.content}`;
	}
}

/* html tag with children (e.g. <div>...</div>, <p>text</p>) */
export class DualTag implements HtmlComponent {
	private openTag: string;
	private closeTag: string;
	private children: HtmlComponent[];
	public constructor(name: string, properties: Record<string, HtmlString>, children: HtmlComponent[] | HtmlComponent) {
		let details = '';
		for (const name in properties)
			details += ` ${name}="${HtmlGuard.get(properties[name]).content}"`;

		this.openTag = `<${name}${details}>`;
		this.closeTag = `</${name}>`;
		this.children = (Array.isArray(children) ? children : [children]);
	}
	public simple(): boolean { return false; }
	public finalize(indent: string): string {
		if (this.children.length == 0)
			return `${indent}${this.openTag}${this.closeTag}`;

		/* inline the child if its the only one and it fits on a single line */
		if (this.children.length == 1 && this.children[0].simple())
			return `${indent}${this.openTag}${this.children[0].finalize('')}${this.closeTag}`;

		/* construct the element with indented children */
		let body = '', childIndent = `\t${indent}`;
		for (const child of this.children)
			body += `\n${child.finalize(childIndent)}`;
		return `${indent}${this.openTag}${body}\n${indent}${this.closeTag}`;
	}
}

/* full html page; automatically adds utf-8 charset and defaults language to 'en' */
export class HtmlPage {
	private _head: HtmlComponent[];
	private _body: HtmlComponent[];
	public language: HtmlString;

	constructor(language: HtmlString = 'en', head: HtmlComponent[] | HtmlComponent = [], body: HtmlComponent[] | HtmlComponent = []) {
		this._head = (Array.isArray(head) ? head : [head]);
		this._body = (Array.isArray(body) ? body : [body]);
		this.language = language;
	}

	public get head(): HtmlComponent[] {
		return this._head;
	}
	public set head(value: HtmlComponent | HtmlComponent[]) {
		this._head = (Array.isArray(value) ? value : [value]);
	}

	public get body(): HtmlComponent[] {
		return this._body;
	}
	public set body(value: HtmlComponent | HtmlComponent[]) {
		this._body = (Array.isArray(value) ? value : [value]);
	}

	public finalize(): string {
		const properties: Record<string, HtmlString> = { style: 'margin:0;height:100%;' };
		if ((typeof this.language == 'string' ? this.language : this.language.content) != '')
			properties['lang'] = this.language;

		const page = new DualTag('html', properties, [
			new DualTag('head', {}, [
				new SingleTag('meta', { charset: 'utf-8' }),
				...this._head
			]),
			new DualTag('body', { style: 'margin:0;height:100%;display:flex;' }, this._body)
		]);
		return `<!DOCTYPE html>\n${page.finalize('')}`;
	}
}

/* embed raw content; if safe is true, the content is trusted and
*	inserted verbatim; otherwise it is html-escaped before insertion */
export function Embed(content: string, safe: boolean): HtmlComponent {
	return new EmbeddedContent(content, safe);
}
export function Meta(name: HtmlString, content: HtmlString): HtmlComponent {
	return new SingleTag('meta', { name, content });
}
export function Title(name: HtmlString): HtmlComponent {
	return new DualTag('title', {}, new EmbeddedContent(HtmlGuard.get(name).content, true));
}
export function LoadStyle(path: HtmlString): HtmlComponent {
	return new SingleTag('link', { rel: 'stylesheet', type: 'text/css', href: path });
}
export function LoadScript(path: HtmlString, properties: Record<string, HtmlString> = {}): HtmlComponent {
	return new DualTag('script', { ...properties, src: path }, []);
}

/* inline css; content is inserted verbatim as <style> is a raw text element */
export function AddStyle(content: string, properties: Record<string, HtmlString> = {}): HtmlComponent {
	return new DualTag('style', properties, [new EmbeddedContent(content, true)]);
}

/* inline javascript; content is inserted verbatim as <script> is a raw text element */
export function AddScript(content: string, properties: Record<string, HtmlString> = {}): HtmlComponent {
	return new DualTag('script', properties, new EmbeddedContent(content, true));
}

export function Text(text: HtmlString, properties: Record<string, HtmlString> = {}): HtmlComponent {
	return new DualTag('p', properties, [new EmbeddedContent(HtmlGuard.get(text).content, true)]);
}
export function Div(properties: Record<string, HtmlString> = {}, children: HtmlComponent[] | HtmlComponent = []): HtmlComponent {
	return new DualTag('div', properties, children);
}
export function LoadingError(): HtmlComponent {
	return Text('Failed to load Page Content', { style: 'font-family: monospace; color: red; font-weight: bold; text-align: center;' });
}
