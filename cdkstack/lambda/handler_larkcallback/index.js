// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as lark from '@larksuiteoapi/node-sdk';
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { DynamoDBClient,
    UpdateCommand,
    GetItemCommand, 
    PutItemCommand } from "@aws-sdk/client-dynamodb";

const utils = require('../utils');

const snsclient = new SNSClient();
const topicArn = process.env.SNS_TOPIC_ARN;
const lark_token = process.env.LARK_TOKEN;
const lark_encrypt_key = process.env.LARK_ENCRYPT_KEY

const dynamodb_tb_events = 'lark_events';
const dbclient = new DynamoDBClient();

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

const larkclient = new lark.Client({
    appId: process.env.LARK_APPID,
    appSecret: process.env.LARK_APP_SECRET,
    appType: lark.AppType.SelfBuild,
});

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
  
// system table api
const queryEventsDDB = async (key) => {
    const queryKey = { event_id: { S: key } };
    const results = await _queryDynamoDb(dynamodb_tb_events, queryKey);
    if (results!=null &&  'header_data' in results.Item){
        return JSON.parse(results.Item.header_data.S);
    }
    return null;
};

const saveEventsDDB = async (event_id, header) =>{
    console.log("=====saveEventsDDB=====")
    const oneDayLater = Math.floor(Date.now()/1000) + (24 * 60 * 60 );
    const item = {
        event_id: { S: event_id }, 
        header_data: {S: JSON.stringify(header)},
        expire_at:{N: oneDayLater.toString()}
    };
    console.log(item)
    _saveDynamoDb(dynamodb_tb_events, item);
}

export const handler = async(event) => {
    const data = JSON.parse(event.body);
    if (data.type === 'url_verification') {
        return {
                statusCode: 200,
                body:JSON.stringify({
                challenge: data.challenge,
            })}
    }else if (data.header.token === lark_token){
        if (data.header.event_type === 'im.message.receive_v1') {
            console.log(data);
            const message = data.event.message;
            const message_id = message.message_id;
            const msg_type = message.message_type;
            const open_chat_id = message.chat_id;
            const event_id = data.header.event_id;

            try{
                let event = await queryEventsDDB(event_id);
                if (!isEmpty(event)){
                    console.error("!!!DUPLICATE EVENT!!!");
                    return { statusCode: 200, }
                }

                await saveEventsDDB(event_id, data.header);
                let msg
                if (msg_type == 'text'){
                    msg = JSON.parse(message.content).text;
                }else if (msg_type == 'image'){
                    msg = JSON.parse(message.content).image_key;
                }else {

                }
               

                try{
                    // 构造首次响应卡片
                    console.log("========5. buildCard=========");
                    let card_content;
                    let msg_body;
                    card_content = utils.buildCard("Pending", utils.getCurrentTime(), "...", "", false, true);
                    console.log("========6. replayLarkMessage=========");
                    msg_body = await replayLarkMessage(message_id, card_content, "interactive");

                     // const msg = JSON.parse(message.content).text;
                    const command = new PublishCommand({
                        TopicArn:topicArn,
                        Message:JSON.stringify({
                            msg_type: msg_type,
                            msg: msg,
                            open_chat_id: open_chat_id,
                            message_id: message_id,
                            msg_body: msg_body,
                        })
                    });

                    await snsclient.send(command);

                }catch(err){
                    console.error("!!!ERR2!!!");
                    console.log(JSON.stringify(err));
                    await larkclient.im.message.create({
                        params: {
                            receive_id_type: 'chat_id',
                        },
                        data: {
                            receive_id: open_chat_id,
                            content: JSON.stringify({text:"!!something error"}),
                            msg_type: 'text',
                        },
                    });
                }

                return { statusCode: 200, }
            }catch(err){
                console.error("!!!ERR1!!!");
                console.log(JSON.stringify(err));
            } finally {
                
            }
        }
    }else{
        return {
                 statusCode: 400,
            }
    }
};