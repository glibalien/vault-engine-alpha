import { describe, expect, it } from 'vitest';
import { fieldTags, inlineTags } from '../../src/tags/inline.js';

describe('inlineTags', () => {
  it('reads tags as Obsidian does', () => {
    expect(inlineTags('#meeting with #Acme about #project/alpha and #2021-plans, #follow_up.')).toEqual(['meeting', 'acme', 'project/alpha', '2021-plans', 'follow_up']);
    expect(inlineTags('#Meeting\n\nand #meeting again')).toEqual(['meeting']);
    expect(inlineTags('(#idea) is not one, but ( #idea ) is')).toEqual(['idea']);
    expect(inlineTags('#réunion and #会议')).toEqual(['réunion', '会议']);
  });

  it('takes no heading, number, link or address for a tag', () => {
    expect(inlineTags('# Heading\n## Another\n#not-a-heading')).toEqual(['not-a-heading']);
    expect(inlineTags('Issue #123 and #2021, but #v2')).toEqual(['v2']);
    expect(inlineTags('See [[Note#Part]], [[#Part]], [text](#part), page#section and https://example.com/#top')).toEqual([]);
    expect(inlineTags('C# and F# are languages; a#b')).toEqual([]);
    expect(inlineTags('#trailing/ and #dash-')).toEqual(['trailing', 'dash']);
  });

  it('reads nothing inside code', () => {
    expect(inlineTags('Use `#define X` and ``#pragma once`` then #real')).toEqual(['real']);
    expect(inlineTags('```\n#!/bin/sh\n#comment\n```\n#after')).toEqual(['after']);
    expect(inlineTags('~~~python\n#comment\n~~~\n#after')).toEqual(['after']);
    // A longer fence is not closed by a shorter one.
    expect(inlineTags('````\n```\n#inside\n```\n````\n#after')).toEqual(['after']);
  });

  it('reads nothing in an indented block or in code that runs over lines', () => {
    expect(inlineTags('An example:\n\n    #meeting in a code block\n\n#real')).toEqual(['real']);
    expect(inlineTags('An example:\n\n\t#meeting\n\n#real')).toEqual(['real']);
    expect(inlineTags('Run `first line\n#meeting second line` and then #real')).toEqual(['real']);
    // A note whose only "tag" is in code carries none.
    expect(inlineTags('    #meeting')).toEqual([]);
    // Indented, but a list item's text and not code.
    expect(inlineTags('- item\n    #nested under it')).toEqual(['nested']);
    // Markup right before the # is not a space.
    expect(inlineTags('`code` then **bold**#notatag and **bold** #tag')).toEqual(['tag']);
  });

  it('reads nothing in an HTML comment or block', () => {
    expect(inlineTags('<!--\n#meeting\n-->\n\n#real')).toEqual(['real']);
    expect(inlineTags('<!-- #meeting -->')).toEqual([]);
    expect(inlineTags('<div>\n#meeting\n</div>\n\n#real')).toEqual(['real']);
    // The same answer whether or not the note also holds code.
    expect(inlineTags('<!-- #meeting -->\n\n`code` and #real')).toEqual(['real']);
  });

  it('reads nothing in code inside a quote or a list', () => {
    expect(inlineTags('> ~~~\n> #meeting\n> ~~~\n\n#real')).toEqual(['real']);
    expect(inlineTags('> ```\n> #meeting\n> ```\n\n> #quoted')).toEqual(['quoted']);
    expect(inlineTags('- step\n  ~~~sh\n  #meeting\n  ~~~\n- #listed')).toEqual(['listed']);
  });
});

describe('fieldTags', () => {
  it('reads a list or one text, with or without #', () => {
    expect(fieldTags(null, JSON.stringify(['Meeting', '#acme', 'project/alpha', 42, '']))).toEqual(['meeting', 'acme', 'project/alpha']);
    expect(fieldTags('meeting, #acme  follow_up', null)).toEqual(['meeting', 'acme', 'follow_up']);
    expect(fieldTags('123', null)).toEqual([]);
    expect(fieldTags(null, 'not json')).toEqual([]);
    expect(fieldTags(null, null)).toEqual([]);
  });
});
