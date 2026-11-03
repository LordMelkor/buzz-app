import { createContext, useContext } from "react";
import type { RelaySession } from "../../features/relay/session";

export const BESTIE_PAGE = "buzz.bestie/bestie";
export type BestieMark = {
  label: string;
  detail: "Bestie";
  avatar: { src: string | undefined; shape: "squircle" };
};
export const BestieNavigationContext = createContext<BestieMark | undefined>(
  undefined,
);
export const BestieConversationContext = createContext<
  { session: RelaySession; channelId: string } | undefined
>(undefined);

export function useBestieConversation(session: RelaySession) {
  const conversation = useContext(BestieConversationContext);
  return conversation?.session === session ? conversation.channelId : undefined;
}
