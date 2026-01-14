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

app.use(
  "/paystack/webhook",
  express.raw({ type: "application/json" })
);

// Supabase client with Service Role key
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_key
});


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
// /ai/chat
// ========================
app.post("/ai/chat", async (req, res) => {
  try {
    const { userId, message } = req.body;
    if (!userId || !message) return res.status(400).json({ error: "userId and message required" });

    // 1️⃣ Fetch user data
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

    // 2️⃣ Build system prompt for OpenAI
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

    // 3️⃣ Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ]
    });

    const reply = completion.choices[0].message.content;

    // 4️⃣ Save AI reply as a post in Supabase
    const { data: post } = await supabase
      .from("posts")
      .insert({ user_id: userId, content: reply })
      .select()
      .single();

    // 5️⃣ Summarize post for memory
    const summaryCompletion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "user", content: `Summarize this post into short AI memory:\n${reply}` }
      ]
    });

    const memorySummary = summaryCompletion.choices[0].message.content.trim();

    await supabase.from("memorySummaries").insert({
      user_id: userId,
      post_id: post.id,
      summary: memorySummary
    });

    // 6️⃣ Return results
    res.json({ reply, post, memorySummary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ========================
// /generateAndSavePost (optional)
// ========================
app.post("/generateAndSavePost", async (req, res) => {
  try {
    const { userId, idea } = req.body;
    if (!userId || !idea) return res.status(400).json({ error: "userId and idea required" });

    const brand = await fetchSingle("brandProfiles", userId);
    const audience = await fetchSingle("audienceProfiles", userId);

    // Get last memory
    const { data: lastMemory } = await supabase
      .from("memorySummaries")
      .select("summary")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const systemPrompt = `
Brand: ${brand?.name}
Tone: ${brand?.tone}
Audience: ${audience?.targetAudience}

Previous Memory:
${lastMemory?.summary || "None"}

Task: Generate a social media post for "${idea}"
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 400,
      messages: [{ role: "system", content: systemPrompt }]
    });

    const newPost = completion.choices[0].message.content.trim();

    const { data: post } = await supabase
      .from("posts")
      .insert({ user_id: userId, content: newPost })
      .select()
      .single();

    const summaryCompletion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "user", content: `Summarize this post into short AI memory:\n${newPost}` }
      ]
    });

    const memorySummary = summaryCompletion.choices[0].message.content.trim();

    await supabase.from("memorySummaries").insert({
      user_id: userId,
      post_id: post.id,
      summary: memorySummary
    });

    res.json({ success: true, newPost, memorySummary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// verify payment
// CALLBACK: called from frontend after Paystack success
app.post("/verify-payment", async (req, res) => {
  const { reference } = req.body;

  if (!reference) {
    return res.status(400).json({ error: "Transaction reference required" });
  }

  try {
    // Verify transaction with Paystack
    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const result = await verifyRes.json();

    if (!result.status || result.data.status !== "success") {
      return res.status(400).json({
        success: false,
        message: "Payment verification failed",
      });
    }

    const email = result.data.customer.email;
    const subscriptionCode = result.data.subscription;

    // ⚠️ IMPORTANT:
    // DO NOT set subscribed=true here
    // Webhook will do that

    res.json({
      success: true,
      message: "Payment received. Subscription activating...",
      email,
      subscriptionCode,
    });

  } catch (err) {
    console.error("Callback verify error:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});
// IMPORTANT: raw body middleware (must be before this route)
app.post(
  "/paystack/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-paystack-signature"];

    // Verify webhook signature
    const hash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest("hex");

    if (hash !== signature) {
      return res.sendStatus(401);
    }

    const event = JSON.parse(req.body.toString());

    try {
      // =========================
      // SUBSCRIPTION ACTIVATED
      // =========================
      if (event.event === "charge.success") {
        const {
          customer,
          subscription,
          plan,
        } = event.data;

        const email = customer.email;
        const subscriptionCode = subscription;
        const customerCode = customer.customer_code;

        // 1️⃣ Find user by email
        const { data: user } = await supabase
          .from("users")
          .select("id")
          .eq("email", email)
          .single();

        if (!user) return res.sendStatus(200);

        // 2️⃣ Update user (FINAL authority)
        await supabase.from("users").update({
          subscribed: true,
          plan: "pro",
          subscription_status: "active",
          subscription_code: subscriptionCode,
          paystack_customer_code: customerCode,
          subscribed_at: new Date().toISOString(),
        }).eq("id", user.id);

        // 3️⃣ Save subscription record
        await supabase.from("subscriptions").upsert({
          user_id: user.id,
          email,
          plan: "pro",
          provider: "paystack",
          subscription_code: subscriptionCode,
          status: "active",
          updated_at: new Date().toISOString(),
        });
      }

      // =========================
      // PAYMENT FAILED
      // =========================
      if (event.event === "invoice.payment_failed") {
        const email = event.data.customer.email;

        await supabase
          .from("users")
          .update({
            subscribed: false,
            subscription_status: "inactive",
          })
          .eq("email", email);
      }

      // =========================
      // SUBSCRIPTION CANCELLED
      // =========================
      if (event.event === "subscription.disable") {
        const subscriptionCode = event.data.subscription_code;

        await supabase
          .from("users")
          .update({
            subscribed: false,
            subscription_status: "cancelled",
          })
          .eq("subscription_code", subscriptionCode);
      }

      res.sendStatus(200);

    } catch (err) {
      console.error("Webhook error:", err);
      res.sendStatus(500);
    }
  }
);
// Start server
const PORT = process.env.PORT || 8000;
app.listen(PORT,"0,0,0,0", () => console.log(`Server running on http://localhost:${PORT}`));