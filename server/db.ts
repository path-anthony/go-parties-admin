import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";

// A connection attempt that gets no answer fails after 10 seconds instead of
// waiting forever (the driver's default is no limit, and a stalled attempt
// then hangs whatever asked for it).
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });

export const prisma = new PrismaClient({ adapter });
