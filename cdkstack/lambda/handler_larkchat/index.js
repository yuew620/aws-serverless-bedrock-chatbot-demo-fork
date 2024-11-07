// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as lark from '@larksuiteoapi/node-sdk';
import { DynamoDBClient,
  UpdateCommand,
  GetItemCommand, 
  PutItemCommand } from "@aws-sdk/client-dynamodb";

import fs from 'fs';

const utils = require('../utils');

const dynamodb_tb = process.env.DB_TABLE;
const dynamodb_tb_stats = 'lark_stats';
const dbclient = new DynamoDBClient();

const start_command = process.env.START_CMD;
const token_count_command = '/tc';
const prompt_template_command = '/sp';

const MAX_SEQ = parseInt(process.env.AWS_CLAUDE_MAX_SEQ)*2+1;
// const aws_ak = process.env.AWS_AK
// const aws_sk = process.env.AWS_SK
// const aws_region_code = process.env.AWS_REGION_CODE
// const aws_llm = process.env.AWS_BEDROCK_CLAUDE_SONNET
const aws_claude_img_desc_prompt = process.env.AWS_CLAUDE_IMG_DESC_PROMPT
const aws_claude_system_prompt = process.env.AWS_CLAUDE_SYSTEM_PROMPT
const aws_claude_max_chat_quota_per_user = process.env.AWS_CLAUDE_MAX_CHAT_QUOTA_PER_USER

const larkclient = new lark.Client({
    appId: process.env.LARK_APPID,
    appSecret: process.env.LARK_APP_SECRET,
    appType: lark.AppType.SelfBuild,
});

function toBase64(filePath) {
  const img = fs.readFileSync(filePath);
  return Buffer.from(img).toString('base64');
}

function isEmpty(value) {
  if (value === null) {
    return true;
  }
  if (typeof value === 'undefined') {
    return true;
  }
  if (typeof value === 'string' && value.trim().length === 0) {
    return true;
  }
  if (Array.isArray(value) && value.length === 0) {
    return true;
  }
  if (typeof value === 'object' && Object.keys(value).length === 0) {
    return true;
  }
  return false;
}

const _queryDynamoDb = async (table_name, key) => {
  const params = {
    Key: key,
    TableName: table_name,
  };
  const command = new GetItemCommand(params);
  try {
    const results = await dbclient.send(command);
    console.log("============_queryDynamoDb============")
    console.log(results)
    if (results==null || !results.Item) {
      return null;
    } 
    return results;
  } catch (err) {
    console.error(err);
    return null;
  }
};

const _saveDynamoDb = async (table_name,item) =>{
  const params = {
      TableName:table_name,
      Item:item
  }
  const command = new PutItemCommand(params);
  try {
      const results = await dbclient.send(command);
      console.log("Items saved success",results);
  } catch (err) {
      console.error(err);
  }
};

// message table api
const queryDynamoDb = async (key, target) => {
  const queryKey = { chat_id: { S: key } };
  const results = await _queryDynamoDb(dynamodb_tb, queryKey);
  if (results!=null &&  target in results.Item){
    return JSON.parse(results.Item[target].S);
  }
  return null;
  // return _queryDynamoDb(dynamodb_tb, queryKey);
};
const saveDynamoDb = async (chat_id, messages, system_prompt) =>{
  console.log("========saveDynamoDb==========")
  const oneDayLater = Math.floor(Date.now()/1000) + (24 * 60 * 60 );
  const item = {
    chat_id:{S:chat_id}, 
    messages:{S:JSON.stringify(messages)},
    system_prompt:{S: JSON.stringify(system_prompt)},
    expire_at:{N: oneDayLater.toString()}
  }
  console.log(item)
  _saveDynamoDb(dynamodb_tb, item);
}

// system table api
const queryStatsDDB = async (key) => {
  const queryKey = { app_id: { S: key } };
  const results = await _queryDynamoDb(dynamodb_tb_stats, queryKey);
  if (results!=null &&  'tokens' in results.Item){
    return JSON.parse(results.Item.tokens.S);
  }
  return null;
};
const saveStatsDDB = async (key, input_tokens, output_tokens) =>{
  console.log("=====saveStatsDDB=====")
  const token_counter = {input_tokens:input_tokens, output_tokens: output_tokens};
  const item = {
    app_id: { S: key }, 
    tokens: {S: JSON.stringify(token_counter)}};
  console.log(item)
  _saveDynamoDb(dynamodb_tb_stats, item);
}

const sendLarkMessage = async (open_chat_id, msg) =>{
  await larkclient.im.message.create({
      params: {
          receive_id_type: 'chat_id',
      },
      data: {
          receive_id: open_chat_id,
          content: JSON.stringify({text: msg}),
          msg_type: 'text',
      },
  });
}

const streamLarkMessage = async(message_id, card) => {
  //console.log("=====streamLarkMessage=====");
  return await larkclient.im.message.patch({
      path: {
        message_id: message_id,
      },
      data: {
        content: card,
      },
    }
  );
}

const replayLarkMessage = async(message_id, card, msg_type) => {
  console.log("=====replayLarkMessage=====");
  console.log(card);
  return await larkclient.im.message.reply({
      path: {
        message_id: message_id,
      },
      data: {
        content: card,
        msg_type: msg_type,
        reply_in_thread: false,
        uuid: utils.generateUUID(),
      },
    },
  ).then(res => {
    return res;
  });
}

const getLarkfile = async(message_id, filekey, type, desc) =>{
  let resp;
  const tempFileName = `/tmp/${Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)}.png`
  try{
    resp = await larkclient.im.messageResource.get({
      path: {
        message_id: message_id,
        file_key: filekey,
      },
      params: {
        type: type,
      },
    });

    await resp.writeFile(tempFileName)
    const base64String = toBase64(tempFileName);
    const contents = [
      {
          type: "image",
          source: {
          type: "base64",
          media_type: "image/png",
          data: base64String,
          }
      },
      {type: "text", text: desc}]; 
      return {role:'user', content:contents};

  } catch (err) {
    console.error(err);
  } finally {
    fs.unlinkSync(tempFileName);
  }
}

export const handler = async (event) => {
  const body = JSON.parse(event.Records[0].Sns.Message);

  const open_chat_id = body.open_chat_id;
  const msg_type = body.msg_type;
  const message_id = body.message_id;
  console.log("========1. parameters=========")
  console.log(body);

  let msg;
  let current_msg;
  let system_prompt;
  if (msg_type == 'text'){
    msg = body.msg;
    current_msg = {role:'user', content:msg}
  } else if (msg_type == 'image') {
    const mage_key = body.msg;
    let desc = aws_claude_img_desc_prompt;
    system_prompt = await queryDynamoDb(open_chat_id, "system_prompt");
    if (!isEmpty(system_prompt))
      desc = system_prompt;
    current_msg = await getLarkfile(message_id, mage_key, msg_type, desc);
  } else {
    await sendLarkMessage(open_chat_id, "'${msg_type}' format is unsupported.");
    return { statusCode: 200,}
  }
  console.log("========2. current_msg=========")
  console.log(current_msg)
 
  let messages;
  let prev_msgs;
  //send command to clear the messages
  if (msg === start_command){ // /rs
    await saveDynamoDb(open_chat_id, null, null);
    await sendLarkMessage(open_chat_id, "Flushed! Let's chat!");
    return  { statusCode: 200}
  } else if (msg === token_count_command){ // /tc
    const tokens = await queryStatsDDB(process.env.LARK_APPID);
    await sendLarkMessage(open_chat_id, JSON.stringify(tokens));
    return  { statusCode: 200}
  } else if (!isEmpty(msg) && msg.startsWith('/sp ')){ // /sp
    const match = msg.match(/\/sp \s*(.*)/);
    if (match) {
      prev_msgs = await queryDynamoDb(open_chat_id, "messages");

      const sytem_prompt = match[1]; 
      await saveDynamoDb(open_chat_id, prev_msgs, sytem_prompt.trim());
      await sendLarkMessage(open_chat_id, "System prompt updated! Let's chat!");
    }
    return  { statusCode: 200}
  } else{
    prev_msgs = await queryDynamoDb(open_chat_id, "messages");
    system_prompt = await queryDynamoDb(open_chat_id, "system_prompt");
  }
  //append the previous msgs
  if (prev_msgs) { 
      if (prev_msgs.length > aws_claude_max_chat_quota_per_user){
        await sendLarkMessage(open_chat_id, "max chat quota reached!");
        return  { statusCode: 200}
      }
      messages = [...prev_msgs,current_msg];
      if (messages.length > MAX_SEQ){
        messages = messages.slice(messages.length-MAX_SEQ,)
      }
  }else{
      messages = [current_msg];
  }
  // console.log(messages);
  
  let text;   
  let message;    
  let response;   
  try {
    let sp = aws_claude_system_prompt;
    if (!isEmpty(system_prompt))
      sp = system_prompt;
    console.log("========3. system_prompt=========")
    console.log(sp)
    // 构造首次响应卡片
    // console.log("========5. buildCard=========");
    let card_content;
    let msg_body = body.msg_body;
    // card_content = utils.buildCard("Pending", utils.getCurrentTime(), "...", "", false, true);
    // console.log("========6. replayLarkMessage=========");
    // msg_body = await replayLarkMessage(message_id, card_content, "interactive");
    // console.log(msg_body);
    if(msg_body.msg == 'success'){
       //response = await utils.invokeClaude3(messages, sp);
      response = await utils.invokeClaude3Stream(messages, sp, async function(msg, endmsg, end){
        //console.log("========7. buildCard=========");
        card_content = utils.buildCard("Result", utils.getCurrentTime(), msg, endmsg, end, true);
        await streamLarkMessage(msg_body.data.message_id, card_content);
      });

      text= response.content[0];
      message={role: 'assistant', content: text.text.trimStart()}

      messages = [...messages, message];
      await saveDynamoDb(open_chat_id, messages, sp)
      console.log("========4. send_message=========")
      console.log(message);

      console.log("========8. updateDDB=========")
      const input_tokens = response.usage.input_tokens;
      const output_tokens = response.usage.output_tokens;
      let tokens = await queryStatsDDB(process.env.LARK_APPID);
      if (!isEmpty(tokens)){
        console.log(tokens)
        tokens.input_tokens += input_tokens;
        tokens.output_tokens += output_tokens;
        console.log(tokens)
      }
      await saveStatsDDB( process.env.LARK_APPID, tokens.input_tokens, tokens.output_tokens);
    }

    //await sendLarkMessage(open_chat_id, message.content);
    //await streamLarkMessage(message_id, message.content);

    return {
        statusCode: 200,
    };

  } catch (error) {
      console.error(JSON.stringify(error));
      message = {content:error.message+'|'+error.stack};
      console.error(message);
  } finally {


  }

};

