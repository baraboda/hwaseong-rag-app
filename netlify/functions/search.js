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
          answer: '관련된 회의 기록을 찾지 못했습니다.',
          sources: []
        })
      };
    }

    // 4. Claude에게 분석 요청
    const context = documents.map((doc, i) => {
      const m = doc.metadata || {};
      const meetingType = m.meeting_type || '회의';
      const date = m.date || '날짜미상';
      const sessionNum = m.session_num || '';
      return `[회의록 ${i+1}] ${meetingType} | ${date} | 제${sessionNum}회\n${doc.content}`;
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
          content: `당신은 국무회의/차관회의 기록 분석 전문가입니다.

아래는 사용자의 검색어입니다:
"""
${query}
"""

아래는 검색된 관련 회의록입니다:
"""
${context}
"""

위 회의록을 바탕으로:
1. 검색어와 관련된 내용을 요약해주세요.
2. 어떤 회의에서 어떤 논의가 있었는지 설명해주세요.
3. 관련 정책이나 후속 조치가 있다면 알려주세요.

회의록 내용을 충실히 인용하여 답변해주세요. 관련 내용이 없으면 솔직하게 말씀해주세요.`
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
