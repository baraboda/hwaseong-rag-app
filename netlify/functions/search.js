const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { query } = JSON.parse(event.body);

    // 1. 질문을 임베딩으로 변환
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        input: query,
        model: 'text-embedding-3-small'
      })
    });
    
    const embeddingData = await embeddingResponse.json();
    const queryEmbedding = embeddingData.data[0].embedding;

    // 2. Supabase에서 유사 문서 검색
    const { data: documents, error } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_count: 5
    });

    if (error) throw error;

    // 3. 검색 결과가 없으면
    if (!documents || documents.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answer: '관련된 국무회의/차관회의 기록을 찾지 못했습니다.',
          sources: []
        })
      };
    }

    // 4. Claude에게 분석 요청
    const context = documents.map((doc, i) => {
      const m = doc.metadata;
      return `[회의록 ${i+1}] ${m.meeting_type} | ${m.date} | 제${m.session_num}회\n${doc.content}`;
    }).join('\n\n---\n\n');

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `당신은 시군구 지역 이슈와 국가 정책을 연결하는 전문가입니다.

아래는 사용자가 입력한 시군구 관련 이슈/기사/대본입니다:
"""
${query}
"""

아래는 관련 국무회의/차관회의 기록입니다:
"""
${context}
"""

위 회의록을 참고하여:
1. 시군구 이슈가 어떤 국가 정책과 연결되는지 설명해주세요. 국무회의 및 차관회의의 입장에서 설명해주세요.
2. 시군구가 어떻게 변화되어야 하는지 국가정책과 관련하여 흐름이 맞도록 제안해주세요.
3. 기사의 경우 시군구 이슈로 기사를 써주되, 반드시 국가정책과의 연관성을 지어서 기사를 써주세요. 
4. 영상의 경우 낚시성 제목을 제안해주세요. 어떤 장면 또는 멘트를 넣어야 국가정책과 흐름이 맞는 것인지 제안해주세요.
5. 추가로 찾아볼 만한 관련 키워드가 있다면 알려주세요

만약 관련성이 낮다면 솔직하게 말씀해주세요.`
        }]
      })
    });

    const claudeData = await claudeResponse.json();
    const answer = claudeData.content[0].text;

    // 5. 결과 반환
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answer,
        sources: documents.map(d => d.metadata)
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
