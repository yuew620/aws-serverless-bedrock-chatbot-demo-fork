import { randomBytes } from 'crypto';
import {
  AccessDeniedException,
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";

const aws_ak = process.env.AWS_AK
const aws_sk = process.env.AWS_SK
const aws_region_code = process.env.AWS_REGION_CODE
const aws_llm = process.env.AWS_BEDROCK_CLAUDE_SONNET

function getRandomInt(min, max) {
  // 确保 min 小于 max
  if (min >= max) {
    throw new Error('min 必须小于 max');
  }

  // 生成一个介于 min 和 max 之间的随机整数
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function generateUUID() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
    (c ^ (randomBytes(1)[0] & (15 >> (c / 4)))).toString(16)
  );
}

export const getCurrentTime = function() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').slice(0, 19);
}

export const buildCard = function (header, time, content, endmsg, end, robot) {
  let endMsg = "正在思考，请稍等..."
  if (end) {
    if (endmsg) {
      endMsg = endmsg;
    }
    endMsg += time
  }
  const card = {
    elements: [
      {
        tag: 'markdown',
        content: content,
        text_align: 'left'
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: endMsg
          }
        ]
      }
    ]
  };
  return JSON.stringify(card);
}

export const invokeClaude3Stream = async (messages, system_prompt, callback) => {
  const client = new BedrockRuntimeClient({ 
    region: aws_region_code,
    credentials: {
      accessKeyId: aws_ak,
      secretAccessKey: aws_sk,
    },
  });

  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    system: system_prompt,
    messages: messages,
    temperature: 0.8,
    top_p: 0.9,
    max_tokens: 2048,
  };

  const command = new InvokeModelWithResponseStreamCommand({
    body: JSON.stringify(payload),
    contentType: "application/json",
    accept: "application/json",
    modelId: aws_llm,
  });

  try {
    const apiResponse = await client.send(command);
    let completeMessage = "";
    let inputTokenCount = 0;
    let outputTokenCount = 0;

    let idx = 0
    for await (const item of apiResponse.body) {
      // Decode each chunk
      const chunk = JSON.parse(new TextDecoder().decode(item.chunk.bytes));

      // Get its type
      const chunk_type = chunk.type;

      // Process the chunk depending on its type
      if (chunk_type === "message_start") {
        // The "message_start" chunk contains the message's role
        console.log(`The message's role: ${chunk.message.role}`)
      } else if (chunk_type === "content_block_delta") {
        // The "content_block_delta" chunks contain the actual response text

        // Print each individual chunk in real-time
        process.stdout.write(chunk.delta.text);

        // ... and add it to the complete message
        completeMessage = completeMessage + chunk.delta.text;
        
        if (idx%getRandomInt(10,20) == 0)
        {
          await callback(completeMessage,  "", false)
        }
        idx++;
      } else if (chunk_type === "message_stop") {
        // The "message_stop" chunk contains some metrics
        const metrics = chunk["amazon-bedrock-invocationMetrics"];
        inputTokenCount = metrics.inputTokenCount;
        outputTokenCount = metrics.outputTokenCount;

        console.log(`\nNumber of input tokens: ${metrics.inputTokenCount}`);
        console.log(`Number of output tokens: ${metrics.outputTokenCount}`);
        console.log(`Invocation latency: ${metrics.invocationLatency}`);
        console.log(`First byte latency: ${metrics.firstByteLatency}`);
        let endmsg = "input:" + inputTokenCount + " output:" + outputTokenCount + " ";
        await callback(completeMessage, endmsg, true)
      }
    }
    // Print the complete message.
    console.log("\nComplete response:");
    console.log(completeMessage);

    const response = {
      content: [{type: 'text', text: completeMessage}],
      usage: { input_tokens: inputTokenCount, output_tokens: outputTokenCount },
    }

    return response;

  }catch (err) {
    if (err instanceof AccessDeniedException) {
      console.error(
        `Access denied. Ensure you have the correct permissions to invoke ${aws_llm}.`,
      );
    } else {
      throw err;
    }
  } finally {

  } 
}

export const invokeClaude3 = async (messages, system_prompt) => {
  const client = new BedrockRuntimeClient({ 
    region: aws_region_code,
    credentials: {
      accessKeyId: aws_ak,
      secretAccessKey: aws_sk,
    },
  });

  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    system: system_prompt,
    messages: messages,
    temperature: 0.8,
    top_p: 0.9,
    max_tokens: 2048,
  };

  const command = new InvokeModelCommand({
    body: JSON.stringify(payload),
    contentType: "application/json",
    accept: "application/json",
    modelId: aws_llm,
  });

  try {
    const response = await client.send(command);
    const decodedResponseBody = new TextDecoder().decode(response.body);
    const responseBody = JSON.parse(decodedResponseBody);
    console.log(responseBody)
    return responseBody;
  } catch (err) {
    if (err instanceof AccessDeniedException) {
      console.error(
        `Access denied. Ensure you have the correct permissions to invoke ${aws_llm}.`,
      );
    } else {
      throw err;
    }
  } finally {

  }
};


export const buildCardTest = (header, time, content, end, robot) => {
  if (content) {
    content = content.replace(/^(.*)/gm, '**\$1**');
  } else if (robot) {
    const card = {
      elements: [
        {
          tag: 'markdown',
          content: content,
          text_align: 'left',
        },
        {
          tag: 'note',
          elements: [
            {
              tag: 'plain_text',
              content: '正在思考，请稍等...',
            },
          ],
        },
      ],
    };

    return JSON.stringify(card);
  }

  if (robot) {
    let note;
    if (end) {
      note = '🤖温馨提示✨✨：输入<帮助> 或 /help 即可获取帮助菜单';
    } else {
      note = '正在处理中，请稍等...';
    }

    const card = {
      elements: [
        {
          tag: 'markdown',
          content: content,
          text_align: 'left',
        },
        {
          tag: 'note',
          elements: [
            {
              tag: 'plain_text',
              content: note,
            },
          ],
        },
      ],
    };

    return JSON.stringify(card);
  }

  if (end) {
    const card = {
      elements: [
        {
          tag: 'column_set',
          flex_mode: 'none',
          background_style: 'default',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              vertical_align: 'top',
              elements: [
                {
                  tag: 'div',
                  text: {
                    content: '**🕐 完成时间：**\n${time}',
                    tag: 'lark_md',
                  },
                },
                {
                  tag: 'markdown',
                  content: content,
                  text_align: 'left',
                },
              ],
            },
          ],
        },
        {
          tag: 'column_set',
          flex_mode: 'none',
          background_style: 'default',
          columns: [],
        },
        {
          tag: 'hr',
        },
        {
          tag: 'div',
          fields: [
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: '**📝祝您生活愉快**',
              },
            },
          ],
        },
        {
          tag: 'note',
          elements: [
            {
              tag: 'plain_text',
              content: '🤖温馨提示✨✨：输入<帮助> 或 /help 即可获取帮助菜单',
            },
          ],
        },
      ],
      header: {
        template: 'violet',
        title: {
          content: header,
          tag: 'plain_text',
        },
      },
    };

    return JSON.stringify(card);
  }

  const card = {
    elements: [
      {
        tag: 'column_set',
        flex_mode: 'none',
        background_style: 'default',
        columns: [
          {
            tag: 'column',
            width: 'weighted',
            weight: 1,
            vertical_align: 'top',
            elements: [
              {
                tag: 'div',
                text: {
                  content: `**🕐 响应时间：**\n${time}`,
                  tag: 'lark_md',
                },
              },
              {
                tag: 'markdown',
                content: content,
                text_align: 'left',
              },
            ],
          },
        ],
      },
      {
        tag: 'column_set',
        flex_mode: 'none',
        background_style: 'default',
        columns: [],
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: '赞一下',
            },
            type: 'primary',
            value: {
              success: true,
              text: 'praise',
            },
          },
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: '踩一下',
            },
            type: 'danger',
            value: {
              success: false,
              text: 'praise',
            },
          },
        ],
      },
      {
        tag: 'hr',
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '🤖温馨提示✨✨：输入<帮助> 或 /help 即可获取帮助菜单',
          },
        ],
      },
    ],
    header: {
      template: 'violet',
      title: {
        content: header,
        tag: 'plain_text',
      },
    },
  };

  return JSON.stringify(card);
};
