const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");
dotenv.config();

const app = express();
app.use(cors())
/*app.use(cors({
  origin:"https://abrand-a5a8.onrender.com",
  credentials:true,
})); */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const supabaseAdmin = supabase; // ✅ Admin client
const client = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
})


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

      const { data: sub, error: subError } = await supabaseAdmin
  .from("subscriptions")
  .insert({
    user_id: user.id,
    subscribed: true,
    plan: "pro",
    email,
    subscription_status: "active",
    subscription_code,
    paystack_customer_code: customer.customer_code,
    subscribed_at: timeStamp,
  })
  .select()
  .single();
  
 //insert in user table
 await supabaseAdmin
  .from("users")
  .update({
    subscribed: true,
    subscription_status: "active",
    subscription_code,
    paystack_customer_code: customer.customer_code,
  })
  .eq("id", user.id);
 
      const pay =  await supabaseAdmin
          .from("payments")
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
      
 return res.status(200).json({
      success: true,
      user: {
        id: auth_id,
        email,
        plan:"free"
      },
    });
    }
    // 4️⃣ Final response
    console.log("pro user")
    return res.status(200).json({
      success: true,
      user: {
        id: auth_id,
        email,
        plan:"pro"
      },
    });
    
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: "Unauthorized" });
  }
});

// ========================
// AI chat route
// ========================
app.post("/ai/chat", verifySupabaseToken, async (req, res) => {
  try {
    // ✅ Always trust token, not frontend
    const userId = req.user.id;
    const { message } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    // ✅ Fetch brand profile
    const { data: branddata, error: brandError } = await supabaseAdmin
      .from("brandProfiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (brandError || !branddata) {
      return res.status(404).json({ message: "No brand profile found" });
    }

    const {
      name = "Unknown",
      tone = "",
      beliefs = [],
      targetAudience = "General",
      bannedWords = [],
    } = branddata;

    // ✅ Fetch offers
    const { data: offers, error: offersError } = await supabaseAdmin
      .from("offers")
      .select("*")
      .eq("user_id", userId);

    if (offersError) throw offersError;

    // ✅ Fetch memory
    const { data: memories, error: memoryError } = await supabaseAdmin
      .from("memorysummaries")
      .select("summary")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(8);

    if (memoryError) throw memoryError;

    // ✅ Build prompt safely
    const systemPrompt = `
You are an AI assistant representing this brand.

BRAND:
- Name: ${name}
- Tone: ${tone}

BELIEFS:
${beliefs.map(b => `- ${b}`).join("\n") || "- None"}

AUDIENCE:
- Target: ${targetAudience}

OFFERS:
${(offers || []).map(o => `- ${o.title}: ${o.description}`).join("\n") || "- None"}

MEMORY:
${(memories || []).map(m => `- ${m.summary}`).join("\n") || "- None"}

RULES:
Never use banned words:
${bannedWords.map(w => `- ${w}`).join("\n") || "- None"}
`;
// ✅ Generate AI response
 
  const completion = await client.chat.completions.create({
  model: "nvidia/ising-calibration-1.5-31b",
  messages:[{ role:"system",
             content:systemPrompt  }],
  temperature: 1,
  top_p: 0.95,
  max_tokens: 32768,
});

const reply = completion.choices[0].message.content;
if (!reply) {
  return res.status(500).json({ error: "AI failed to generate reply" });
}

// ✅ Save post
const { data: post, error: postError } = await supabaseAdmin
  .from("posts")
  .insert({
    user_id: userId,
    content: reply,
  })
  .select()
  .single();

if (postError) throw postError;

// ✅ Summarize memory

const summary = await client.chat.completions.create({
  model: "nvidia/ising-calibration-1.5-31b",
  messages: [
    {
      role: "system",
      content:
        "Summarize this conversation into concise, long-term memory. Include user preferences, goals, important facts, and ongoing tasks. Do not include temporary details.",
    },
    {
      role: "user",
      content: reply,
    },
  ],
  temperature: 0.3,
  max_tokens: 500,
});

const memorySummary = summary.choices[0].message.content;
// ✅ Save memory (only if exists)
if (memorySummary) {
  await supabaseAdmin.from("memorysummaries").insert({
    user_id: userId,
    post_id: post.id,
    summary: memorySummary, // ✅ FIXED HERE
  });
}

// ✅ Final response
return res.status(201).json({
  reply,
  post,
  memorySummary,
});

  } catch (err) {
    console.error("AI chat error:", err);

    return res.status(500).json({
      error: "Something went wrong",
      details: err.message
    });
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