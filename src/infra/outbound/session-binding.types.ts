export type BindingTargetKind = "subagent" | "session";
export type BindingStatus = "active" | "ending" | "ended";
export type SessionBindingPlacement = "current" | "child";
export type SessionBindingErrorCode =
  | "BINDING_ADAPTER_UNAVAILABLE"
  | "BINDING_CAPABILITY_UNSUPPORTED"
  | "BINDING_CREATE_FAILED";

export type ConversationRef = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};

export type SessionBindingRecord = {
  bindingId: string;
  targetSessionKey: string;
  targetKind: BindingTargetKind;
  conversation: ConversationRef;
  status: BindingStatus;
  boundAt: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
};

export type SessionBindingBindInput = {
  targetSessionKey: string;
  targetKind: BindingTargetKind;
  conversation: ConversationRef;
  placement?: SessionBindingPlacement;
  metadata?: Record<string, unknown>;
  ttlMs?: number;
};

export type SessionBindingUnbindInput = {
  bindingId?: string;
  targetSessionKey?: string;
  reason: string;
  /**
   * When true, adapters that understand this flag should treat the
   * unbind request as a no-op and leave their records in place. Used
   * by session-reset (as opposed to session-delete) so that routing
   * survives a context-reset flow where the session key is reused.
   *
   * Adapters are NOT required to honor this — each one opts in.
   * As of 2026-04-13: Telegram and the generic current-conversation
   * binding honor it; Discord and other channels ignore it and keep
   * their existing behavior (including Discord's farewell post).
   */
  preserveBindings?: boolean;
};

export type SessionBindingCapabilities = {
  adapterAvailable: boolean;
  bindSupported: boolean;
  unbindSupported: boolean;
  placements: SessionBindingPlacement[];
};
