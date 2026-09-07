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
