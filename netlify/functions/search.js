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
    const cleanQuery = query.trim();

    // 1. 키워드 검색 (ILIKE) - 청크 데이터라 속도 빠름
    let keywordDocs = [];

    // 전략 A: 입력 문장 전체 포함 (가장 정확)
    const { data: exactMatches } = await supabase
      .from('documents')
      .select('id, content, metadata')
      .ilike('content', `%${cleanQuery}%`)
      .limit(5);

    if (exactMatches && exactMatches.length > 0) {
      keywordDocs = exactMatches;
    } else {
      // 전략 B: 단어별 검색 (입력 문장이 없을 때)
      const words = cleanQuery.split(/\s+/).filter(w => w.length >= 2);

      if (words.length > 0) {
        // 첫 단어로 넓게 찾고 (30개)
        const { data: looseMatches } = await supabase
          .from('documents')
          .select('id, content, metadata')
          .ilike('content', `%${words[0]}%`)
          .limit(30);

        if (looseMatches) {
          // JS에서 나머지 단어도 포함된 것만 남김 (AND 조건)
          keywordDocs = looseMatches.filter(doc => {
            return words.slice(1).every(w => doc.content.includes(w));
          }).slice(0, 5);
          
          // 필터링 결과 없으면 1단어 매칭 결과라도 사용
          if (keywordDocs.length === 0) {
            keywordDocs = looseMatches.slice(0, 5);
          }
        }
      }
    }

    // 2. 벡터 검색 (의미 기반 보완)
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        input: cleanQuery,
        model: 'text-embedding-3-small'
      })
    });

    const embeddingData = await embeddingResponse.json();
    const queryEmbedding = embeddingData.data[0].embedding;

    const { data: vectorDocs } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_count: 10
    });

    // 3. 결과 합치기
    const seenIds = new Set();
    const combinedDocs = [];
    
    // 키워드 우선
    for (const doc of keywordDocs) {
      if (!seenIds.has(doc.id)) {
        seenIds.add(doc.id);
        combinedDocs.push(doc);
      }
    }
    // 벡터 결과 추가
    if (vectorDocs) {
      for (const doc of vectorDocs) {
        if (!seenIds.has(doc.id)) {
          seenIds.add(doc.id);
          combinedDocs.push(doc);
        }
      }
    }

    const finalDocs = combinedDocs.slice(0, 10);

    if (finalDocs.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answer: '관련된 기록을 찾지 못했습니다.',
          sources: []
        })
      };
    }

    // 4. Claude에게 보낼 Context 구성 (자르기 로직 삭제됨)
    // 청크가 800자이므로 그대로 보내도 10개 합쳐봐야 8000자 내외. Claude 처리 가능.
    const context = finalDocs.map((doc, i) => {
      const m = doc.metadata || {};
      return `[문서 ${i+1}]
      - 날짜: ${m.date || '미상'}
      - 내용: ${doc.content}`; // 원본 그대로 전달
    }).join('\n\n---\n\n');

    // 5. Claude 요청
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `당신은 회의록 분석 전문가입니다.
질문: "${cleanQuery}"

[검색된 문서 조각들]:
"""
${context}
"""

답변 가이드:
1. 위 [검색된 문서 조각들]에 있는 내용만으로 답변하세요.
2. 질문과 관련된 내용이 있다면 구체적인 수치(예: 3800선 등)와 발언 내용을 포함해서 설명하세요.
3. 문서 조각들이 서로 연결되는 내용이면 종합해서 설명해주세요.`
        }]
      })
    });

    const claudeData = await claudeResponse.json();
    const answer = claudeData.content[0].text;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answer,
        sources: finalDocs.map(d => d.metadata)
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
