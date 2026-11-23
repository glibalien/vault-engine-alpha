/** Minimal structural message shape the read-side renders. A host's richer
 *  message type (web ChatMessage / ai UIMessage) structurally satisfies it. */
export interface ChatUIPart {
  type: string;
  text?: string;
}
export interface ChatUIMessage {
  id: string;
  role: string;
  parts: ChatUIPart[];
}
