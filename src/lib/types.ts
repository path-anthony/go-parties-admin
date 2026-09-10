export type Item = {
  id: string;
  accountId: string;
  name: string;
  category: string;
  price: string | null; // serialized Decimal
  priceUnit: string | null;
  notes: string | null;
  photoUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewItem = {
  name: string;
  category: string;
  price: string;
  priceUnit: string;
  notes: string;
  photoUrl: string;
};

export type AskGoMessage = { role: "user" | "assistant"; content: string };

export type RecommendResponse =
  | { ready: false; message: string }
  | { ready: true; message: string; items: Item[]; total: number };

export type Lead = {
  id: string;
  accountId: string;
  theme: string;
  itemsReturned: {
    items: { id: string; name: string; category: string; price: number | null; priceUnit: string | null }[];
    total: number;
  };
  createdAt: string;
};
