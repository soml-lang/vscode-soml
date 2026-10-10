import {getCompletionContext, formatKey, type EditorParseResult} from 'soml-lang';
import {type Span} from './service.ts';

export type Completion = {label: string; insertText: string; detail: string; range: Span; snippet: boolean};

const values = [
	{
		label: 'integer',
		insertText: '${1:0}',
		detail: 'Signed 64-bit integer',
		snippet: true,
	},
	{
		label: 'float',
		insertText: '${1:0.0}',
		detail: '64-bit floating-point number',
		snippet: true,
	},
	{
		label: 'true',
		insertText: 'true',
		detail: 'Boolean',
		snippet: false,
	},
	{
		label: 'false',
		insertText: 'false',
		detail: 'Boolean',
		snippet: false,
	},
	{
		label: 'null',
		insertText: 'null',
		detail: 'Present null value',
		snippet: false,
	},
	{
		label: 'infinity',
		insertText: 'infinity',
		detail: 'Positive infinity',
		snippet: false,
	},
	{
		label: '-infinity',
		insertText: '-infinity',
		detail: 'Negative infinity',
		snippet: false,
	},
	{
		label: 'string',
		insertText: '\'${1:text}\'',
		detail: 'Literal string',
		snippet: true,
	},
	{
		label: 'array',
		insertText: '[$0]',
		detail: 'Array',
		snippet: true,
	},
	{
		label: 'object',
		insertText: '{${1:key}: ${2:null}}',
		detail: 'Object',
		snippet: true,
	},
	{
		label: 'duration',
		insertText: '${1:30}${2|s,ms,m,h,us,ns|}',
		detail: 'Duration with an explicit unit',
		snippet: true,
	},
	{
		label: 'instant',
		insertText: '${1:2026-01-01T00:00:00Z}',
		detail: 'Instant with a required UTC offset',
		snippet: true,
	},
];

/**
Offer values and sibling keys using the parser's recovered syntax snapshot.
*/
export function completionItems(document: EditorParseResult, offset: number): Completion[] {
	if (!Number.isSafeInteger(offset) || offset < 0) {
		return [];
	}

	const context = getCompletionContext(document, offset);
	if (!context) {
		return [];
	}

	const {slot, prefix, range} = context;
	if (slot.kind === 'member-value' || slot.kind === 'array-element') {
		return values.filter(value => value.label.startsWith(prefix)).map(value => ({...value, range}));
	}

	if (slot.kind !== 'key') {
		return [];
	}

	const object = slot.owner;
	const parent = context.ancestors[context.ancestors.indexOf(object) - 1];
	if (parent?.type !== 'EditorArray') {
		return [];
	}

	const usedKeys = new Set(object.members.flatMap(member => (member !== slot.member || slot.member.colonRange !== undefined) && member.type === 'EditorMember' && member.key.type === 'EditorKey' ? [member.key.key] : []));
	const suggestions: Completion[] = [];
	for (const sibling of parent.elements) {
		if (sibling === object || sibling.type !== 'EditorObject') {
			continue;
		}

		for (const member of sibling.members) {
			if (member.type !== 'EditorMember' || member.key.type !== 'EditorKey') {
				continue;
			}

			const {key} = member.key;
			if (usedKeys.has(key) || !key.startsWith(prefix)) {
				continue;
			}

			const quoted = formatKey(key);
			const isSnippet = !slot.member?.colonRange;
			const insertText = isSnippet ? `${quoted.replaceAll(/[$\\\}]/gv, String.raw`\$&`)}: \${1:null}` : quoted;
			usedKeys.add(key);
			suggestions.push({
				label: quoted, insertText, detail: 'Key from another object in this array', range, snippet: isSnippet,
			});
			if (suggestions.length >= 100) {
				return suggestions;
			}
		}
	}

	return suggestions;
}
