const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Supabase client with Service Role key
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const supabaseAdmin = supabase; // ✅ Admin client

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_key
});

app.get('/', (req,res)=>{
  console.log("backend working")
  res.send({message:"backend working"})
})
// Helper to fetch single row from Supabase
async function fetchSingle(table, userId) {
  const { data } = await supabase
    .from(table)
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

// ========================
// Supabase token verification middleware
// ========================
const verifySupabaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" })
    console.log("missing token")
  }

  const token = authHeader.replace("Bearer ", "");

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ error: "Invalid or expired token" });
    console.log("invalid or expired token")
  }

  req.user = data.user;
  next();
};

// ========================
// User sync route
// ========================
app.post("/api/user/sync", verifySupabaseToken, async (req, res) => {
  try {
    const user = req.user;

    const auth_id = user.id;
    const email = user.email;
    
    // 1️⃣ Upsert user
    const { error: userError } = await supabaseAdmin
      .from("users")
      .upsert({
        id: auth_id,
        email,
        
      });

    if (userError) {
      console.error(userError);
      return res.status(500).json({ message: "User sync failed" });
    }

    // 2️⃣ Check subscription
    const { data: existingSub, error: subCheckError } =
      await supabaseAdmin
        .from("subscriptions")
        .select("*")
        .eq("user_id", auth_id)
        .maybeSingle();

    if (subCheckError) {
      console.error(subCheckError);
      return res.status(500).json({ message: "Subscription check failed" });
    }

    // 3️⃣ Create FREE plan if none exists
    let subscription = existingSub;

    if (!existingSub) {
      const { data: newSub, error: subCreateError } =
        await supabaseAdmin
          .from("subscriptions")
          .insert({
            user_id: auth_id,
            plan: "free",
            status: "active",
            expires_at: null,
          })
          .select()
          .single();

      if (subCreateError) {
        console.error(subCreateError);
        return res.status(500).json({ message: "Subscription creation failed" });
      }

      subscription = newSub;
      
    }

    // 4️⃣ Final response
    res.status(200).json({
      success: true,
      user: {
        id: auth_id,
        email,
      
      },
      subscription,
    });
console.log(subscription)
    console.log("✅ User synced & subscription ensured");
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: "Unauthorized" });
  }
});

// ========================
// AI chat route
// ========================
app.post("/ai/chat", async (req, res) => {
  try {
    const { userId, message } = req.body;
    if (!userId || !message) return res.status(400).json({ error: "userId and message required" });

    // Fetch user data
    const [brand, audience, rules] = await Promise.all([
      fetchSingle("brandProfiles", userId),
      fetchSingle("audienceProfiles", userId),
      fetchSingle("aiRules", userId)
    ]);

    const { data: offers } = await supabase.from("offers").select("*").eq("user_id", userId);
    const { data: memories } = await supabase
      .from("memorySummaries")
      .select("summary")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(8);

    const systemPrompt = `
You are an AI assistant representing this brand.

BRAND:
- Name: ${brand?.name || "Unknown"}
- Tone: ${brand?.tone || "Neutral"}

BELIEFS:
${(brand?.beliefs || []).map(b => `- ${b}`).join("\n")}

AUDIENCE:
- Target: ${audience?.targetAudience || "General"}

OFFERS:
${(offers || []).map(o => `- ${o.title}: ${o.description}`).join("\n")}

MEMORY:
${(memories || []).map(m => `- ${m.summary}`).join("\n")}

RULES:
Never use banned words:
${(rules?.bannedWords || []).map(w => `- ${w}`).join("\n")}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ]
    });

    const reply = completion.choices[0]?.message?.content || "";

    // Save AI reply
    const { data: post } = await supabase
      .from("posts")
      .insert({ user_id: userId, content: reply })
      .select()
      .single();

    // Summarize memory
    const summaryCompletion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [{ role: "user", content: `Summarize this post into short AI memory:\n${reply}` }]
    });

    const memorySummary = summaryCompletion.choices[0]?.message?.content.trim() || "";

    await supabase.from("memorySummaries").insert({
      user_id: userId,
      post_id: post.id,
      summary: memorySummary
    });

    res.json({ reply, post, memorySummary });
  } catch (err) {
    console.error("AI chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ========================
// Verify payment
// ========================
app.post("/verify-payment", async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: "Transaction reference required" });

  try {
    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const result = await verifyRes.json();

    if (!result.status || result.data.status !== "success") {
      return res.status(400).json({ success: false, message: "Payment verification failed" });
    }

    const email = result.data.customer.email;
    const subscriptionCode = result.data.subscription;

    res.json({ success: true, message: "Payment received. Subscription activating...", email, subscriptionCode });
  } catch (err) {
    console.error("verify-payment error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ========================
// Paystack webhook
// ========================
app.post("/paystack/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const hash = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(req.body.toString())
    .digest("hex");

  if (hash !== signature) return res.sendStatus(401);

  const event = JSON.parse(req.body.toString());

  try {
    // Charge success
    if (event.event === "charge.success") {
      const { customer, subscription } = event.data;
      const email = customer.email;

      const { data: user } = await supabase.from("users").select("id").eq("email", email).single();
      if (!user) return res.sendStatus(200);

      await supabase.from("users").update({
        subscribed: true,
        plan: "pro",
        subscription_status: "active",
        subscription_code: subscription,
        paystack_customer_code: customer.customer_code,
        subscribed_at: new Date().toISOString(),
      }).eq("id", user.id);

      await supabase.from("subscriptions").upsert({
        user_id: user.id,
        email,
        plan: "pro",
        provider: "paystack",
        subscription_code: subscription,
        status: "active",
        updated_at: new Date().toISOString(),
      });
    }

    // Payment failed
    if (event.event === "invoice.payment_failed") {
      const email = event.data.customer.email;
      await supabase.from("users").update({
        subscribed: false,
        subscription_status: "inactive",
      }).eq("email", email);
    }

    // Subscription cancelled
    if (event.event === "subscription.disable") {
      const subscriptionCode = event.data.subscription_code;
      await supabase.from("users").update({
        subscribed: false,
        subscription_status: "cancelled",
      }).eq("subscription_code", subscriptionCode);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// Start server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));