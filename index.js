const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

dotenv.config();

const app = express();
app.use(cors({
  origin:"https://abrand-a5a8.onrender.com",
  credentials:true,
}));
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const supabaseAdmin = supabase; // ✅ Admin client

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_key
});

app.post(
  "/paystack/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {

      const signature = req.headers["x-paystack-signature"];
      if (!signature) return res.sendStatus(400);

      const hash = crypto
        .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
        .update(req.body)
        .digest("hex");

      const hashBuffer = Buffer.from(hash, "hex");
      const sigBuffer = Buffer.from(signature, "hex");

      if (
        hashBuffer.length !== sigBuffer.length ||
        !crypto.timingSafeEqual(hashBuffer, sigBuffer)
      ) {
        console.log("❌ Invalid signature");
        return res.sendStatus(401);
      }

      console.log("✅ Webhook verified");

      const event = JSON.parse(req.body.toString());

      const { customer, reference, amount, currency, paid_at, status, subscription_code } = event.data || {};
      const email = customer?.email;

      if (!email) {
        console.log("No customer email");
        return res.sendStatus(400);
      }

      const timeStamp = new Date().toISOString();

      // 🔹 SUCCESSFUL PAYMENT
      if (event.event === "charge.success") {

        

        const { data: user } = await supabaseAdmin
          .from("users")
          .select("id")
          .eq("email", email)
          .single();

        if (!user) {
          console.log("User not found");
          return res.sendStatus(404);
        }

      const sub = await supabaseAdmin
          .from("subscriptions")
          .update({
            subscribed: true,
            plan: "pro",
            email,
            subscription_status: "active",
            subscription_code: reference,
            paystack_customer_code: customer.customer_code,
            subscribed_at: timeStamp,
          })
          .eq("id", user.id);

      const pay =  await supabaseAdmin
          .from("payment")
          .insert({
            user_id: user.id,
            email,
            amount: amount / 100,
            currency,
            payment_reference: reference,
            provider: "paystack",
            status,
            created_at: paid_at || timeStamp,
          });
console.log("💰 Charge success received");
console.log(sub);
console.log(pay);
        return res.sendStatus(200);
      }

      // 🔹 FAILED PAYMENT
      else if (event.event === "invoice.payment_failed") {

        console.log("⚠️ Payment failed");

    const failuser = await supabaseAdmin
          .from("users")
          .update({
            subscribed: false,
            subscription_status: "inactive"
          })
          .eq("email", email);
  console.log(failuser)
  console.log("user failed to uodate subscriptions")
        return res.sendStatus(200);
      }

      // 🔹 SUBSCRIPTION CANCELLED
      else if (event.event === "subscription.disable") {

        console.log("🚫 Subscription cancelled");

        if (!subscription_code) {
          return res.sendStatus(400);
        }

        const newfail = await supabaseAdmin
          .from("users")
          .update({
            subscribed: false,
            subscription_status: "cancelled"
          })
          .eq("subscription_code", subscription_code);
         console.log(newfail)
         console.log("its new fail")
        return res.sendStatus(200);
      }

      else {
        console.log("Unhandled event:", event.event);
        return res.sendStatus(200);
      }

    } catch (err) {
      console.error("🔥 Webhook error:", err);
      return res.sendStatus(500);
    }
  }
);
app.use(express.json())
// Supabase client with Service Role key

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
    
    console.log("missing token")
    return res.status(401).json({ error: "Missing token" })
    
  }

  const token = authHeader.replace("Bearer ", "");

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data?.user) {
    console.log("invalid or expired token")
    return res.status(401).json({ error: "Invalid or expired token" });
    
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
    const timeStamp = new Date().toISOString();

    const auth_id = user.id;
    const email = user.email;
    console.log(user)
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
         await supabaseAdmin.from("subscriptions").insert({
    
    subscribed: false,
    plan: "free",
    email: email,
    subscription_status: "free",
    subscription_code: null, // better to store reference
    paystack_customer_code:null,
    subscribed_at: timeStamp,
  }).select().single();
  
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
 console.log("transaction reference")
  try {
    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const result = await verifyRes.json();

    if (!result.status || result.data.status !== "success") {
      return res.status(400).json({ success: false, message: "Payment verification failed" });
      console.log("payment verification failed")
    }

    const email = result.data.customer.email;
    const subscriptionCode = result.data.subscription;

    res.json({ success: true, message: "Payment received. Subscription activating...", email, subscriptionCode });
    console.log("Payment received")
  } catch (err) {
    console.error("verify-payment error:", err);
    res.status(500).json({ success: false, message: "Server error" });
    console.log("server error")
  }
});

// ========================
// Paystack webhook
// ========================


// cancel subscription
app.post("/cancel-subscription", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.replace("Bearer ", "");

    // ✅ Verify Supabase JWT
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // 🔥 Now we trust this user
    const userId = user.id;

    // Get subscription data
    const { data: dbUser } = await supabaseAdmin
      .from("users")
      .select("subscription_code, paystack_customer_code")
      .eq("id", userId)
      .single();

    if (!dbUser || !dbUser.subscription_code) {
      return res.status(400).json({ error: "No active subscription" });
    }

    // Disable subscription on Paystack
    const response = await fetch("https://api.paystack.co/subscription/disable", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: dbUser.subscription_code,
        token: dbUser.paystack_customer_code,
      }),
    });

    const result = await response.json();

    if (!result.status) {
      return res.status(400).json({ error: "Paystack cancel failed" });
    }

    // Update database
    await supabaseAdmin.from("users").update({
      subscribed: false,
      subscription_status: "cancelled",
    }).eq("id", userId);

    await supabaseAdmin.from("subscriptions").update({
      status: "cancelled",
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);

    res.json({ success: true });

  } catch (err) {
    console.error("Cancel error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Start server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));