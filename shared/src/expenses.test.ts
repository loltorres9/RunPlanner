import { describe, expect, it } from 'vitest';
import { expenseInputSchema, parseMoney, settleUp, splitEqually, type Expense, type Settlement } from './expenses.js';

const names: Record<string, string> = { a: 'Anna', b: 'Ben', c: 'Clara', d: 'Dora' };

function expense(paidBy: string, amountCents: number, shares: [string, number][], currency = 'EUR'): Expense {
  return {
    id: Math.random().toString(),
    eventId: 'e',
    paidBy,
    paidByName: names[paidBy]!,
    description: 'x',
    amountCents,
    currency,
    shares: shares.map(([userId, cents]) => ({ userId, userName: names[userId]!, amountCents: cents })),
    createdBy: paidBy,
    createdAt: 0,
  };
}

function settlement(from: string, to: string, amountCents: number): Settlement {
  return {
    id: 's',
    groupId: 'g',
    fromUser: from,
    fromName: names[from]!,
    toUser: to,
    toName: names[to]!,
    amountCents,
    currency: 'EUR',
    createdBy: from,
    createdAt: 0,
  };
}

describe('splitEqually', () => {
  it('verteilt übrige Cent auf die ersten Personen', () => {
    expect(splitEqually(1000, ['a', 'b', 'c']).map((s) => s.amountCents)).toEqual([334, 333, 333]);
    expect(splitEqually(500, [])).toEqual([]);
  });
});

describe('parseMoney', () => {
  it('versteht Komma und Punkt', () => {
    expect(parseMoney('12,50')).toBe(1250);
    expect(parseMoney('12.5 €')).toBe(1250);
    expect(parseMoney('80')).toBe(8000);
    expect(parseMoney('1,234')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
  });
});

describe('expenseInputSchema', () => {
  it('verlangt, dass die Anteile den Betrag ergeben', () => {
    const ok = { paidBy: 'a', description: 'Hütte', amountCents: 300, shares: [{ userId: 'a', amountCents: 150 }, { userId: 'b', amountCents: 150 }] };
    expect(expenseInputSchema.safeParse(ok).success).toBe(true);
    expect(expenseInputSchema.safeParse({ ...ok, amountCents: 301 }).success).toBe(false);
  });
});

describe('settleUp', () => {
  it('Beispiel: Anna zahlt die Unterkunft für drei', () => {
    const transfers = settleUp([expense('a', 24000, [['a', 8000], ['b', 8000], ['c', 8000]])], []);
    expect(transfers.map((t) => `${t.fromName}→${t.toName} ${t.amountCents}`)).toEqual(['Ben→Anna 8000', 'Clara→Anna 8000']);
  });

  it('verrechnet über mehrere Ausgaben zu wenigen Überweisungen', () => {
    const transfers = settleUp(
      [
        expense('a', 3000, [['a', 1000], ['b', 1000], ['c', 1000]]),
        expense('b', 3000, [['a', 1000], ['b', 1000], ['c', 1000]]),
      ],
      [],
    );
    // Anna und Ben haben je 10 € gut, Clara schuldet 20 €.
    expect(transfers).toHaveLength(2);
    expect(transfers.every((t) => t.from === 'c' && t.amountCents === 1000)).toBe(true);
  });

  it('heben sich gegenseitige Schulden auf, gibt es nichts zu tun', () => {
    const transfers = settleUp([expense('a', 1000, [['b', 1000]]), expense('b', 1000, [['a', 1000]])], []);
    expect(transfers).toEqual([]);
  });

  it('erledigte Zahlungen verschwinden aus der Liste', () => {
    const expenses = [expense('a', 24000, [['a', 8000], ['b', 8000], ['c', 8000]])];
    expect(settleUp(expenses, [settlement('b', 'a', 8000)]).map((t) => t.from)).toEqual(['c']);
    expect(settleUp(expenses, [settlement('b', 'a', 8000), settlement('c', 'a', 8000)])).toEqual([]);
  });

  it('rechnet Währungen getrennt ab', () => {
    const transfers = settleUp([expense('a', 1000, [['b', 1000]]), expense('b', 500, [['a', 500]], 'CHF')], []);
    expect(transfers.map((t) => `${t.currency} ${t.from}→${t.to}`)).toEqual(['CHF a→b', 'EUR b→a']);
  });

  it('die Summen gehen bei vielen Personen auf', () => {
    const expenses = [
      expense('a', 1001, [['a', 251], ['b', 250], ['c', 250], ['d', 250]]),
      expense('c', 777, [['b', 389], ['d', 388]]),
    ];
    const transfers = settleUp(expenses, []);
    const net = new Map<string, number>();
    for (const t of transfers) {
      net.set(t.from, (net.get(t.from) ?? 0) + t.amountCents);
      net.set(t.to, (net.get(t.to) ?? 0) - t.amountCents);
    }
    expect(net.get('b')).toBe(639);
    expect(net.get('d')).toBe(638);
    expect(net.get('a')).toBe(-750);
    expect(net.get('c')).toBe(-527);
    expect(transfers.length).toBeLessThanOrEqual(3);
  });
});
