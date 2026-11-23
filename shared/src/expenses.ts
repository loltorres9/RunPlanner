/**
 * Kosten teilen: Ausgaben einer Veranstaltung, wer wem wie viel schuldet und
 * welche Zahlungen schon erledigt sind.
 *
 * Beträge sind immer ganze Cent (Ganzzahlen), damit sich beim Aufteilen nichts
 * durch Rundung verliert. Jede Währung wird getrennt abgerechnet.
 */

import { z } from 'zod';

export interface ExpenseShare {
  userId: string;
  userName: string;
  amountCents: number;
}

export interface Expense {
  id: string;
  eventId: string;
  paidBy: string;
  paidByName: string;
  description: string;
  amountCents: number;
  currency: string;
  shares: ExpenseShare[];
  createdBy: string;
  createdAt: number;
}

/** Eine erledigte Zahlung: `fromUser` hat `toUser` den Betrag überwiesen. */
export interface Settlement {
  id: string;
  groupId: string;
  fromUser: string;
  fromName: string;
  toUser: string;
  toName: string;
  amountCents: number;
  currency: string;
  createdBy: string;
  createdAt: number;
}

/** Vorschlag: `from` überweist `to` den Betrag. */
export interface Transfer {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  amountCents: number;
  currency: string;
}

const cents = z.number().int().min(1).max(100_000_000);

export const expenseInputSchema = z
  .object({
    paidBy: z.string().min(1),
    description: z.string().trim().min(1).max(200),
    amountCents: cents,
    shares: z
      .array(z.object({ userId: z.string().min(1), amountCents: z.number().int().min(0).max(100_000_000) }))
      .min(1)
      .max(100),
  })
  .refine((e) => new Set(e.shares.map((s) => s.userId)).size === e.shares.length, {
    message: 'Jede Person nur einmal aufführen',
    path: ['shares'],
  })
  .refine((e) => e.shares.reduce((sum, s) => sum + s.amountCents, 0) === e.amountCents, {
    message: 'Die Anteile ergeben nicht den Gesamtbetrag',
    path: ['shares'],
  });
export type ExpenseInput = z.input<typeof expenseInputSchema>;

export const settlementInputSchema = z
  .object({
    fromUser: z.string().min(1),
    toUser: z.string().min(1),
    amountCents: cents,
    currency: z.string().trim().length(3),
  })
  .refine((s) => s.fromUser !== s.toUser, { message: 'Zahlung an sich selbst', path: ['toUser'] });
export type SettlementInput = z.input<typeof settlementInputSchema>;

/**
 * Teilt einen Betrag gleichmäßig. Übrige Cent bekommen die ersten Personen,
 * damit die Summe exakt stimmt (10,00 € durch 3 = 3,34 + 3,33 + 3,33).
 */
export function splitEqually(totalCents: number, userIds: string[]): { userId: string; amountCents: number }[] {
  if (userIds.length === 0) return [];
  const base = Math.floor(totalCents / userIds.length);
  const rest = totalCents - base * userIds.length;
  return userIds.map((userId, index) => ({ userId, amountCents: base + (index < rest ? 1 : 0) }));
}

/** Rechnet "12,50" oder "12.5" in Cent um; null bei ungültiger Eingabe. */
export function parseMoney(text: string): number | null {
  const clean = text.trim().replace(/\s|€/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

/** Saldo je Währung und Person: positiv = bekommt Geld, negativ = schuldet Geld. */
export function balances(expenses: Expense[], settlements: Settlement[]): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  const add = (currency: string, userId: string, amount: number) => {
    const map = result.get(currency) ?? new Map<string, number>();
    map.set(userId, (map.get(userId) ?? 0) + amount);
    result.set(currency, map);
  };
  for (const e of expenses) {
    add(e.currency, e.paidBy, e.amountCents);
    for (const s of e.shares) add(e.currency, s.userId, -s.amountCents);
  }
  for (const s of settlements) {
    add(s.currency, s.fromUser, s.amountCents);
    add(s.currency, s.toUser, -s.amountCents);
  }
  return result;
}

/**
 * Wer schuldet wem: möglichst wenige Überweisungen. Gierig: Die Person mit der
 * größten Schuld zahlt an die Person mit dem größten Guthaben, bis alles aufgeht.
 */
export function settleUp(expenses: Expense[], settlements: Settlement[]): Transfer[] {
  const names = new Map<string, string>();
  for (const e of expenses) {
    names.set(e.paidBy, e.paidByName);
    for (const s of e.shares) names.set(s.userId, s.userName);
  }
  for (const s of settlements) {
    names.set(s.fromUser, s.fromName);
    names.set(s.toUser, s.toName);
  }
  const transfers: Transfer[] = [];
  for (const [currency, map] of [...balances(expenses, settlements)].sort(([a], [b]) => a.localeCompare(b))) {
    const byName = (a: [string, number], b: [string, number]) =>
      (names.get(a[0]) ?? a[0]).localeCompare(names.get(b[0]) ?? b[0]);
    const debtors = [...map].filter(([, v]) => v < 0).map(([id, v]): [string, number] => [id, -v]).sort(byName);
    const creditors = [...map].filter(([, v]) => v > 0).sort(byName);
    while (debtors.length > 0 && creditors.length > 0) {
      debtors.sort((a, b) => b[1] - a[1]);
      creditors.sort((a, b) => b[1] - a[1]);
      const debtor = debtors[0]!;
      const creditor = creditors[0]!;
      const amount = Math.min(debtor[1], creditor[1]);
      transfers.push({
        from: debtor[0],
        fromName: names.get(debtor[0]) ?? '?',
        to: creditor[0],
        toName: names.get(creditor[0]) ?? '?',
        amountCents: amount,
        currency,
      });
      debtor[1] -= amount;
      creditor[1] -= amount;
      if (debtor[1] === 0) debtors.shift();
      if (creditor[1] === 0) creditors.shift();
    }
  }
  return transfers;
}
