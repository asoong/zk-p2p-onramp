import React, { useState } from 'react';
import { useAsync, useUpdateEffect } from "react-use";
import styled from 'styled-components';

import { Button } from "./Button";
import { Col, SubHeader } from "./Layout";
import { LabeledTextArea } from './LabeledTextArea';
import { ProgressBar } from "../components/ProgressBar";

import { downloadProofFiles, generateProof, verifyProof } from "../helpers/zkp";
import { insert13Before10 } from "../scripts/generate_input";
import { inputBuffer } from "../helpers/inputBuffer";
import { packedNBytesToString } from "../helpers/binaryFormat";

const generate_inputs = require("../scripts/generate_input");


interface SubmitOrderGenerateProofFormProps {
  loggedInWalletAddress: string;
  setSubmitOrderProof: (proof: string) => void;
  setSubmitOrderPublicSignals: (publicSignals: string) => void;
}
 
export const SubmitOrderGenerateProofForm: React.FC<SubmitOrderGenerateProofFormProps> = ({
  loggedInWalletAddress,
  setSubmitOrderProof,
  setSubmitOrderPublicSignals
}) => {
  const [emailFull, setEmailFull] = useState<string>(localStorage.emailFull || "");
  const [publicSignals, setPublicSignals] = useState<string>(localStorage.publicSignals || "");
  const [proof, setProof] = useState<string>(localStorage.proof || "");

  const [displayMessage, setDisplayMessage] = useState<string>("Generate Proof");
  const [downloadProgress, setDownloadProgress] = useState<number>(0);


  const [status, setStatus] = useState<
    | "not-started"
    | "generating-input"
    | "downloading-proof-files"
    | "generating-proof"
    | "error-bad-input"
    | "error-failed-to-download"
    | "error-failed-to-prove"
    | "done"
    | "sending-on-chain"
    | "sent"
  >("not-started");

  const [stopwatch, setStopwatch] = useState<Record<string, number>>({
    startedDownloading: 0,
    finishedDownloading: 0,
    startedProving: 0,
    finishedProving: 0,
  });

  const recordTimeForActivity = (activity: string) => {
    setStopwatch((prev) => ({
      ...prev,
      [activity]: Date.now(),
    }));
  };

  const filename = "circuit";

  var Buffer = require("buffer/").Buffer; // note: the trailing slash is important!

  // computed state
  const { value, error } = useAsync(async () => {
    try {
      const circuitInputs = await generate_inputs(Buffer.from(atob(emailFull)), "1235"); // TODO order ID
      return circuitInputs;
    } catch (e) {
      return {};
    }
  }, [emailFull, loggedInWalletAddress]);

  // local storage stuff
  useUpdateEffect(() => {
    if (value) {
      if (localStorage.emailFull !== emailFull) {
        console.info("Wrote email to localStorage");
        localStorage.emailFull = emailFull;
      }
    }
    if (proof) {
      if (localStorage.proof !== proof) {
        console.info("Wrote proof to localStorage");
        localStorage.proof = proof;
      }
    }
    if (publicSignals) {
      if (localStorage.publicSignals !== publicSignals) {
        console.info("Wrote publicSignals to localStorage");
        localStorage.publicSignals = publicSignals;
      }
    }
  }, [value]);

  if (error) console.error(error);
  
  const circuitInputs = value || {};
  console.log("Circuit inputs:", circuitInputs);

  return (
    <SubmitOrderGenerateProofFormContainer>
      <SubHeader>Generate Proof</SubHeader>
      <LabeledTextArea
        label="Full Email with Headers"
        value={emailFull}
        onChange={(e) => {
            setEmailFull(e.currentTarget.value);
        }}
        />
      <ButtonContainer>
        <Button
          disabled={emailFull.length === 0}           // TODO: Add back in no selected order claim id check
          onClick={async () => {
            console.log("Generating proof...");
            setDisplayMessage("Generating proof...");
            setStatus("generating-input");

            const formattedArray = await insert13Before10(Uint8Array.from(Buffer.from(emailFull)));
            // Due to a quirk in carriage return parsing in JS, we need to manually edit carriage returns to match DKIM parsing
            console.log("formattedArray", formattedArray);
            console.log("buffFormArray", Buffer.from(formattedArray.buffer));
            console.log("buffFormArray", formattedArray.toString());

            let input = "";
            try {
              input = await generate_inputs(Buffer.from(formattedArray.buffer));
            } catch (e) {
              console.log("Error generating input", e);
              setDisplayMessage("Prove");
              setStatus("error-bad-input");
              return;
            }
            console.log("Generated input:", JSON.stringify(input));

            // Insert input structuring code here
            // const input = buildInput(pubkey, msghash, sig);
            // console.log(JSON.stringify(input, (k, v) => (typeof v == "bigint" ? v.toString() : v), 2));

            /*
              Download proving files
            */
            recordTimeForActivity("startedDownloading");
            setDisplayMessage("Downloading compressed proving files... (this may take a few minutes)");
            setStatus("downloading-proof-files");
            await downloadProofFiles(filename, () => {
              setDownloadProgress((p) => p + 1);
            });
            console.timeEnd("zk-dl");
            recordTimeForActivity("finishedDownloading");

            /*
              Generate proof
            */
            console.time("zk-gen");
            recordTimeForActivity("startedProving");
            setDisplayMessage("Starting proof generation... (this will take 6-10 minutes and ~5GB RAM)");
            setStatus("generating-proof");
            console.log("Starting proof generation");
            // alert("Generating proof, will fail due to input");

            const { proof, publicSignals } = await generateProof(input, "circuit"); 
            console.log("Finished proof generation");
            console.timeEnd("zk-gen");
            recordTimeForActivity("finishedProving");

            /*
              Set proof
            */
            setProof(JSON.stringify(proof));
            setSubmitOrderProof(JSON.stringify(proof));

            /*
              Retrieve public signals
            */
            let kek = publicSignals.map((x: string) => BigInt(x));
            let soln = packedNBytesToString(kek.slice(0, 12));
            let soln2 = packedNBytesToString(kek.slice(12, 147));
            let soln3 = packedNBytesToString(kek.slice(147, 150));
            setPublicSignals(`From: ${soln}\nTo: ${soln2}\nUsername: ${soln3}`);
            
            /*
            Set public signals
            */
           setPublicSignals(JSON.stringify(publicSignals));
           setSubmitOrderPublicSignals(JSON.stringify(publicSignals));

            if (!circuitInputs) {
              setStatus("error-failed-to-prove");
              return;
            }
            setDisplayMessage("Finished computing ZK proof");
            setStatus("done");
            try {
              (window as any).cJson = JSON.stringify(circuitInputs);
              console.log("wrote circuit input to window.cJson. Run copy(cJson)");
            } catch (e) {
              console.error(e);
            }
          }}
        >
          {displayMessage}
        </Button>
      </ButtonContainer>
      {displayMessage === "Downloading compressed proving files... (this may take a few minutes)" && (
          <ProgressBar width={downloadProgress * 10} label={`${downloadProgress} / 10 items`} />
        )}
        <ProcessStatus status={status}>
          {status !== "not-started" ? (
            <div>
              Status:
              <span data-testid={"status-" + status}>{status}</span>
            </div>
          ) : (
            <div data-testid={"status-" + status}></div>
          )}
          <TimerDisplay timers={stopwatch} />
        </ProcessStatus>
    </SubmitOrderGenerateProofFormContainer>
  );
};

const SubmitOrderGenerateProofFormContainer = styled(Col)`
  width: 100%;
  gap: 1rem;
  align-self: flex-start;
`;

const ProcessStatus = styled.div<{ status: string }>`
  font-size: 8px;
  padding: 8px;
  border-radius: 8px;
`;

const ButtonContainer = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between; // Adjust the space between the buttons
`;

const TimerDisplayContainer = styled.div`
  display: flex;
  flex-direction: column;
  font-size: 8px;
`;

const TimerDisplay = ({ timers }: { timers: Record<string, number> }) => {
  return (
    <TimerDisplayContainer>
      {timers["startedDownloading"] && timers["finishedDownloading"] ? (
        <div>
          Zkey Download time:&nbsp;
          <span data-testid="download-time">{timers["finishedDownloading"] - timers["startedDownloading"]}</span>ms
        </div>
      ) : (
        <div></div>
      )}
      {timers["startedProving"] && timers["finishedProving"] ? (
        <div>
          Proof generation time:&nbsp;
          <span data-testid="proof-time">{timers["finishedProving"] - timers["startedProving"]}</span>ms
        </div>
      ) : (
        <div></div>
      )}
    </TimerDisplayContainer>
  );
};
