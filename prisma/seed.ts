import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { seedHeroSlides } from "../server/heroSeed.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const account = await prisma.account.upsert({
    where: { email: "info@thegoeventgroup.com" },
    update: {},
    create: {
      name: "The Go Event Group",
      email: "info@thegoeventgroup.com",
    },
  });

  console.log(`Seeded account: ${account.name} (${account.id})`);
  // Block A6: the first Home page photos, from the storefront repo on this machine.
  console.log(await seedHeroSlides(prisma, account.id));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
