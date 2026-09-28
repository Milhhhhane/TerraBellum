import http from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" };
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/certs") { res.setHeader("content-type","application/json"); return res.end(JSON.stringify({ keys: [jwk] })); }
  if (u.pathname === "/sign") {
    const t = await new SignJWT({ email: "x@y.z" }).setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(u.searchParams.get("iss") ?? "https://accounts.google.com").setAudience(u.searchParams.get("aud") ?? "test-client")
      .setSubject(u.searchParams.get("sub")).setIssuedAt().setExpirationTime(u.searchParams.get("exp") ? Number(u.searchParams.get("exp")) : "1h").sign(privateKey);
    return res.end(t);
  }
  res.statusCode = 404; res.end();
}).listen(9999, "127.0.0.1");
