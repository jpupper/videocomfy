// Using built-in fetch in Node 18+
require('dotenv').config();

async function testModels() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
        console.error("❌ ERROR: GEMINI_API_KEY no encontrada en .env");
        return;
    }

    console.log("🔍 Consultando modelos para la Key:", key.substring(0, 5) + "...");

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        const data = await response.json();
        
        if (data.error) {
            console.log("❌ Error de la API:", data.error.message);
            return;
        }

        if (data.models) {
            console.log("✅ Modelos disponibles que soportan 'generateContent':");
            data.models
                .filter(m => m.supportedGenerationMethods.includes('generateContent'))
                .forEach(m => console.log(`- ${m.name} (${m.displayName})` || m.name));
        } else {
            console.log("❓ No se devolvieron modelos. Respuesta completa:", data);
        }
    } catch (error) {
        console.error("🔥 Error de red:", error.message);
    }
}

testModels();
