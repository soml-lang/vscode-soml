import {
	getEditorContext,
	formatCollectionEdits,
	ParseError,
	type FormatEdit,
	type EditorParseResult,
	type EditorNode,
} from 'soml-lang';
import {type Span} from './service.ts';

/**
Adjust leading whitespace and expand a collection when Enter splits its items, using syntax rather than string-content patterns.
*/
export function typingIndentation(document: EditorParseResult, offset: number, character: string, unit: string): FormatEdit[] {
	const {text} = document;
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
		return [];
	}

	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	const prefix = text.slice(lineStart, offset);
	const whitespace = /^[\t ]*/v.exec(prefix)![0];
	function indentationAt(position: number): string {
		const start = text.lastIndexOf('\n', position - 1) + 1;
		return /^[\t ]*/v.exec(text.slice(start))![0];
	}

	let indentation: string | undefined;
	let comma: Span | undefined;
	if (character === '}' || character === ']') {
		if (prefix !== whitespace + character) {
			return [];
		}

		const context = getEditorContext(document, offset, {side: 'left'});
		const collection = context?.ancestors.findLast(node => (node.type === 'EditorArray' || node.type === 'EditorObject') && node.closingRange?.[1] === offset);
		if (collection) {
			indentation = indentationAt(collection.range[0]);
		}
	} else if (character === '\n' && prefix === whitespace && lineStart > 0) {
		const previousStart = text.lastIndexOf('\n', lineStart - 2) + 1;
		let end = lineStart - 1;
		let context;
		// Ignore completed trailing comments while locating the syntax before Enter.
		while (end > previousStart) {
			while (end > previousStart && (text[end - 1] === ' ' || text[end - 1] === '\t')) {
				end--;
			}

			context = getEditorContext(document, end, {side: 'left'});
			const token = context?.token;
			if (!token || (token.kind !== 'lineComment' && token.kind !== 'blockComment') || token.range[0] < previousStart || token.range[1] > end) {
				break;
			}

			end = token.range[0];
		}

		const token = context?.token;
		if (token && (token.kind === 'string' || token.kind === 'blockComment') && token.range[1] > end) {
			return [];
		}

		if (token?.kind === 'punctuation' && text.slice(...token.range) === ',') {
			comma = token.range;
			const ancestors = context?.ancestors ?? [];
			const collection = ancestors.findLast(node => node.type === 'EditorArray' || node.type === 'EditorObject');
			if (collection?.closingRange) {
				const entries = collection.type === 'EditorArray' ? collection.elements : collection.members;
				const lineEnd = text.indexOf('\n', offset);
				if (entries.some(entry => entry.range[0] >= offset && (lineEnd === -1 || entry.range[0] < lineEnd))) {
					try {
						return formatCollectionEdits(document, collection, {layout: 'multiline'});
					} catch (error) {
						if (!(error instanceof ParseError)) {
							throw error;
						}
					}
				}
			}

			context = getEditorContext(document, comma[0], {side: 'left'});
		}

		const member = context?.ancestors.findLast(node => node.type === 'EditorMember');
		if (member?.colonRange && member.colonRange[1] <= end && member.value.range[0] >= lineStart) {
			indentation = indentationAt(member.key.range[0]) + unit;
		} else if (member && isComplete(member.value) && member.value.range[1] <= end) {
			indentation = indentationAt(member.key.range[0]);
		} else {
			const collection = context?.ancestors.findLast(node => (node.type === 'EditorArray' || (node.type === 'EditorObject' && node.braced)) && (!node.closingRange || node.closingRange[0] >= lineStart));
			if (collection) {
				indentation = indentationAt(collection.range[0]) + unit;
			}
		}
	}

	if (comma) {
		return [{range: [comma[0], lineStart + indentationAt(offset).length], text: text.slice(comma[1], lineStart) + (indentation ?? whitespace)}];
	}

	return indentation === undefined || indentation === whitespace ? [] : [{range: [lineStart, lineStart + whitespace.length], text: indentation}];
}

function isComplete(node: EditorNode): boolean {
	return node.type === 'EditorScalar' || ((node.type === 'EditorObject' || node.type === 'EditorArray') && node.closingRange !== undefined);
}
