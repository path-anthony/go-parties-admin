import { AsyncLocalStorage } from "node:async_hooks";

// Who is doing this request. requireAuth (server/auth.ts) runs the rest of
// the request inside runAsActor, so anything downstream (an activity entry,
// a message log row, a contract send, an accepted bid, a settings change)
// can record the person by name without every function growing a parameter.
// Outside a staff request (automation, webhooks, the customer portal) there
// is no actor and the records say so by leaving the name empty.
export type Actor = { id: string; name: string; role: "Owner" | "Staff" };

const store = new AsyncLocalStorage<Actor>();

export function runAsActor<T>(actor: Actor, fn: () => T): T {
  return store.run(actor, fn);
}

export function currentActor(): Actor | null {
  return store.getStore() ?? null;
}

// The two columns every attributed row carries.
export function actorFields(): { userId: string | null; userName: string | null } {
  const a = currentActor();
  return { userId: a?.id ?? null, userName: a?.name ?? null };
}
