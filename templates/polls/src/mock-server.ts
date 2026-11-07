// Run the in-process poll mock (community + VTA + ballot box, rules only, no crypto) and print the settings for the CLI.
//   npm run mock -w @buildathon/polls            # then, in another terminal, paste the printed lines
import { startPollsMock } from "@buildathon/polls-client/mock";

const mock = await startPollsMock({ port: Number(process.env.POLLS_MOCK_PORT ?? 8399) });
console.log(`poll mock on ${mock.url} (every signer may manage; nothing is verified cryptographically)
export VTC_URL=${mock.vtcUrl} VTA_URL=${mock.vtaUrl} BALLOT_BOX_URL=${mock.boxUrl} POLL_BALLOT_BOX='${mock.boxDid}' POLL_CAST_DELAY_MS=0 VTA_CREDENTIAL= VTC_DID= APP_DID=
Ctrl-C stops it.`);
process.on("SIGINT", () => void mock.close().then(() => process.exit(0)));
