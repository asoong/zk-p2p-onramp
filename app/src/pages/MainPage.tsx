// @ts-ignore
import React, { useEffect, useMemo, useState } from "react";
import { useAsync, useMount, useUpdateEffect } from "react-use";
// @ts-ignore
// @ts-ignore
import _, { add } from "lodash";
// @ts-ignore
import { generate_inputs, insert13Before10 } from "../scripts/generate_input";
import styled, { CSSProperties } from "styled-components";
import { sshSignatureToPubKey } from "../helpers/sshFormat";
import { Link, useSearchParams } from "react-router-dom";
import { dkimVerify } from "../helpers/dkim";
import atob from "atob";
import { downloadProofFiles, generateProof, verifyProof } from "../helpers/zkp";
import { packedNBytesToString } from "../helpers/binaryFormat";
import { LabeledTextArea } from "../components/LabeledTextArea";
import { SingleLineInput } from "../components/SingleLineInput";
import { Button } from "../components/Button";
import { Col, Row } from "../components/Layout";
// import { NumberedStep } from "../components/NumberedStep";
import { TopBanner } from "../components/TopBanner";
import { CustomTable } from '../components/CustomTable';
import { useAccount, useContractWrite, useContractRead, usePrepareContractWrite } from "wagmi";
import { ProgressBar } from "../components/ProgressBar";
import { abi } from "../helpers/comp.abi";
import { isSetIterator } from "util/types";
var Buffer = require("buffer/").Buffer; // note: the trailing slash is important!

const generate_input = require("../scripts/generate_input");

enum FormState {
  DEFAULT = "DEFAULT",
  NEW = "NEW",
  CLAIM = "CLAIM",
  UPDATE = "UPDATE",
}

enum OrderStatus {
  UNOPENED = "unopened",
  OPEN = "open",
  FILLED = "filled",
  CANCELLED = "cancelled",
}

interface OnRampOrder {
  orderId: number;
  sender: string;
  amount: number;
  maxAmount: number;
  status: OrderStatus;
}

enum OrderClaimStatus {
  UNSUBMITTED = "unsubmitted",
  SUBMITTED = "submitted",
  USED = "used",
  CLAWBACK = "clawback"
}

interface OnRampOrderClaim {
  venmoId: number;
  status: OrderClaimStatus;
  expirationTimestamp: number;
}

export const MainPage: React.FC<{}> = (props) => {
  // raw user inputs
  const filename = "email";

  /*
    App State
  */

  const [emailSignals, setEmailSignals] = useState<string>("");
  const [emailFull, setEmailFull] = useState<string>(localStorage.emailFull || "");
  const [proof, setProof] = useState<string>(localStorage.proof || "");
  const [publicSignals, setPublicSignals] = useState<string>(localStorage.publicSignals || "");
  const [displayMessage, setDisplayMessage] = useState<string>("Prove and Claim");
  const [emailHeader, setEmailHeader] = useState<string>("");
  const { address } = useAccount();
  const [ethereumAddress, setEthereumAddress] = useState<string>(address ?? "");

  const [verificationMessage, setVerificationMessage] = useState("");
  const [verificationPassed, setVerificationPassed] = useState(false);
  // const [lastAction, setLastAction] = useState<"" | "sign" | "verify" | "send">("");
  const [showBrowserWarning, setShowBrowserWarning] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);

  // ----- new state -----
  const [lastAction, setLastAction] = useState<"" | "new" | "create" | "claim" | "cancel" | "complete">("");
  const [newOrderAmount, setNewOrderAmount] = useState<number>(0);
  const [newOrderMaxAmount, setNewOrderMaxAmount] = useState<number>(0);
  const [actionState, setActionState] = useState<FormState>(FormState.DEFAULT);
  const [selectedOrder, setSelectedOrder] = useState<OnRampOrder>({});
  const [selectedOrderClaim, setSelectedOrderClaim] = useState<OnRampOrderClaim>({});

  // fetched state
  const [orders, setOrders] = useState<OnRampOrder[]>([]);
  // const [orderClaims, setOrderClaims] = useState<string[]>([]); // TODO: populate with order claim structs

  // computed state
  const { value, error } = useAsync(async () => {
    try {
      const circuitInputs = await generate_inputs(Buffer.from(atob(emailFull)), ethereumAddress);
      return circuitInputs;
    } catch (e) {
      return {};
    }
  }, [emailFull, ethereumAddress]);

  const circuitInputs = value || {};
  console.log("Circuit inputs:", circuitInputs);

  // const formatExpiration = (expirationTimestamp: number) => {
  //   const expirationDate = new Date(expirationTimestamp);
  //   const now = new Date();
    
  //   if (expirationDate < now) {
  //     return "Expired";
  //   } else {
  //     const formattedDate = expirationDate.toLocaleString();
  //     return formattedDate;
  //   }
  // };

  // table state
  const orderTableHeaders = ['Sender', 'Token Amount', 'Max', 'Status'];
  const orderTableData = orders.map((order) => [
    formatAddressForTable(order.sender),
    order.amount,
    order.maxAmount,
    order.status,
  ]);

  const orderClaimsTableHeaders = ['Taker', 'Venmo Handle', 'Expiration'];
  const orderClaimsTableData = orders.slice(0, 2).map((order) => [
    formatAddressForTable(order.sender),
    "Richard-Liang-2",
    new Date().toLocaleString(),
  ]);

  /*
    Misc Helpers
  */

  let formHeaderText;
  switch (actionState) {
    case FormState.NEW: // Maker creates a new order
      formHeaderText = "New Order";
      break;
    case FormState.CLAIM: // Taker selects an order to claim it
      formHeaderText = "Claim Order";
      break;
    case FormState.UPDATE: // Maker selects their order to cancel or complete it
      formHeaderText = "Cancel or Complete Order";
      break;
    default: // Form loads with no order selected
      formHeaderText = "Create or Select an Order";
  }

  // const formatExpiration = (expirationTimestamp: number) => {
  //   const expirationDate = new Date(expirationTimestamp);
  //   const now = new Date();
    
  //   if (expirationDate < now) {
  //     return "Expired";
  //   } else {
  //     const formattedDate = expirationDate.toLocaleString();
  //     return formattedDate;
  //   }
  // };

  function formatAddressForTable(inputString) {
    const prefix = inputString.substring(0, 4);
    const suffix = inputString.substring(inputString.length - 4);
    return `${prefix}...${suffix}`;
  }

  /*
    Read transactions
  */

  // TODO: remove gibberish COMP total supply read, making sure wagmi is working
  const {
    data: fetchedOrders,
    isLoading: isReadAllOrdersLoading,
    isError: isReadAllOrdersError,
    refetch,
  } = useContractRead({
    addressOrName: '0x3587b2F7E0E2D6166d6C14230e7Fe160252B0ba4', // TODO: Update with proper escrow contract address
    contractInterface: abi,
    functionName: 'totalSupply', // TODO: Update with proper function name when deployed
  });

  // function getAllOrders() external view returns (Order[] memory) {
  // const {
  //   data: allOrders,
  //   isLoading: isReadAllOrdersLoading,
  //   isError: isReadAllOrdersError,
  //   refetch,
  // } = useContractRead({
  //   addressOrName: '', // TODO: Update with proper escrow contract address
  //   contractInterface: abi,
  //   functionName: 'getAllOrders',
  // });

  // function getClaimsForOrder(uint256 _orderId) external view returns (OrderClaim[] memory) {
  // const {
  //   data: claimedOrders,
  //   isLoading: claimedOrdersLoading,
  //   isError: claimedOrdersError,
  // } = useContractRead({
  //   addressOrName: '', // TODO: Update with proper escrow contract address
  //   contractInterface: abi,
  //   functionName: 'getAllOrders',
  //   args: [selectedOrder.orderId],
  // });

  /*
    Write transactions
  */

  // function postOrder(uint256 _amount, uint256 _maxAmountToPay) external onlyRegisteredUser() 
  const { config: writeCreateOrderConfig } = usePrepareContractWrite({
    addressOrName: '0x3587b2F7E0E2D6166d6C14230e7Fe160252B0ba4', // TODO: Update with proper escrow contract address
    contractInterface: abi,
    functionName: 'postOrder',
    args: [newOrderAmount, newOrderMaxAmount],
    onError: (error: { message: any }) => {
      console.error(error.message);
    },
  });

  const {
    data: newOrderData,
    isLoading: isWriteNewOrderLoading,
    isSuccess: isWriteNewOrderSuccess,
    write: writeNewOrder
  } = useContractWrite(writeCreateOrderConfig);
  console.log(
    "Create new order txn details:",
    writeNewOrder,
    newOrderData,
    isWriteNewOrderLoading,
    isWriteNewOrderSuccess,
    writeCreateOrderConfig
  );

  // function claimOrder(uint256 _orderNonce) external  onlyRegisteredUser()
  const { config: writeClaimOrderConfig } = usePrepareContractWrite({
    addressOrName: '0x3587b2F7E0E2D6166d6C14230e7Fe160252B0ba4', // TODO: Update with proper escrow contract address
    contractInterface: abi,
    functionName: 'claimOrder',
    args: [selectedOrder?.orderId],
    onError: (error: { message: any }) => {
      console.error(error.message);
    },
  });

  const {
    data: claimOrderData,
    isLoading: isWriteClaimOrderLoading,
    isSuccess: isWriteClaimOrderSuccess,
    write: writeClaimOrder
  } = useContractWrite(writeClaimOrderConfig);
  console.log(
    "Create claim order txn details:",
    writeClaimOrder,
    claimOrderData,
    isWriteClaimOrderLoading,
    isWriteClaimOrderSuccess,
    writeClaimOrderConfig
  );

  // function onRamp( uint256 _orderId, uint256 _offRamper, VenmoId, bytes calldata _proof) external onlyRegisteredUser()
  const { config: writeCompleteOrderConfig } = usePrepareContractWrite({
    addressOrName: '0x3587b2F7E0E2D6166d6C14230e7Fe160252B0ba4', // TODO: Update with proper escrow contract address
    contractInterface: abi,
    functionName: 'onRamp',
    args: [selectedOrder?.orderId], // TODO: pass in the completed proof
    // args: [...reformatProofForChain(proof), publicSignals ? JSON.parse(publicSignals) : null],
    onError: (error: { message: any }) => {
      console.error(error.message);
    },
  });

  const {
    data: completeOrderData,
    isLoading: isWriteCompleteOrderLoading,
    isSuccess: isWriteCompleteOrderSuccess,
    write: writeCompleteOrder
  } = useContractWrite(writeCompleteOrderConfig);
  console.log(
    "Create claim order txn details:",
    proof,
    publicSignals,
    writeCompleteOrder,
    completeOrderData,
    isWriteCompleteOrderLoading,
    isWriteCompleteOrderSuccess,
    writeCompleteOrderConfig
  );

  // TODO: function cancelOrder(uint256 _orderId) external

  // TODO: function clawback(uint256 _orderId) external {

  /*
    Hooks
  */

  useEffect(() => {
    console.log('Attempting to set orders...');
    console.log(Date.now().toLocaleString());

    if (!isReadAllOrdersLoading && !isReadAllOrdersError && fetchedOrders) {
      // Process fetched orders and update the state
      // Format the fetched order status as needed

      // TODO: Remove this once orders are fetched, currently fetching Comp total supply on goerli
      console.log('Fetched orders:', fetchedOrders);
      console.log(Date.now().toLocaleString());
      console.log(fetchedOrders.toString());
      
      // TODO: Replace with conversion logic once orders are fetched from contract
      const sanitizedOrders: OnRampOrder[] = [];
      for (let i = 0; i < 5; i++) {
        const order: OnRampOrder = {
          orderId: i,
          sender: "0x24506DC1918183960Ac04dB859EB293B115952af",
          amount: i * 100,
          maxAmount: i * 101,
          status: OrderStatus.OPEN,
        };
        sanitizedOrders.push(order);
      }

      // Update orders state
      setOrders(sanitizedOrders);
    }
  }, [fetchedOrders, isReadAllOrdersLoading, isReadAllOrdersError]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      console.log('Refetching orders...');

      refetch();
    }, 15000); // Refetch every 15 seconds

    return () => {
      clearInterval(intervalId);
    };
  }, [refetch]);

  useEffect(() => {
    const userAgent = navigator.userAgent;
    const isChrome = userAgent.indexOf("Chrome") > -1;
    if (!isChrome) {
      setShowBrowserWarning(true);
    }
  }, []);

  useEffect(() => {
    if (address) {
      setEthereumAddress(address);
    } else {
      setEthereumAddress("");
    }
  }, [address]);
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
  const [zkeyStatus, setzkeyStatus] = useState<Record<string, string>>({
    a: "not started",
    b: "not started",
    c: "not started",
    d: "not started",
    e: "not started",
    f: "not started",
    g: "not started",
    h: "not started",
    i: "not started",
    k: "not started",
  });
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

  const reformatProofForChain = (proof: string) => {
    return [
      proof ? JSON.parse(proof)["pi_a"].slice(0, 2) : null,
      proof
        ? JSON.parse(proof)
            ["pi_b"].slice(0, 2)
            .map((g2point: any[]) => g2point.reverse())
        : null,
      proof ? JSON.parse(proof)["pi_c"].slice(0, 2) : null,
    ];
  };

  /*
    Additional Listeners
  */

  useMount(() => {
    function handleKeyDown() {
      setLastAction("");
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

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

  const handleOrderRowClick = (rowData: any[]) => {
    const [rowIndex] = rowData;
    const orderToSelect = orders[rowIndex];

    console.log("Selected order: ", orderToSelect)
    if (orderToSelect.sender === address) {
      setActionState(FormState.UPDATE);
    } else {
      setActionState(FormState.CLAIM);
    }

    setSelectedOrder(orderToSelect);
  };

  const handleOrderClaimRowClick = (rowData: any[]) => {
    // const [rowIndex] = rowData;
    // const orderToSelect = orders[rowIndex];

    // console.log("Selected order: ", orderToSelect)
    // if (orderToSelect.sender === address) {
    //   setActionState(FormState.UPDATE);
    // } else {
    //   setActionState(FormState.CLAIM);
    // }

    // setSelectedOrder(orderToSelect);
  };

  /*
    Container
  */

  return (
    <Container>
      {showBrowserWarning && <TopBanner message={"ZK P2P On-Ramp only works on Chrome or Chromium-based browsers."} />}
      <div className="title">
        <Header>ZK P2P On-Ramp From Venmo Header</Header>
      </div>
      <Main>
        <Column>
          <SubHeader>Orders</SubHeader>
          <CustomTable headers={orderTableHeaders} data={orderTableData} onRowClick={handleOrderRowClick}/>
          <Button
            onClick={async () => {
              setLastAction("new");
              setActionState(FormState.NEW);
            }}
          >
            New Order
          </Button>
        </Column>
        <Column>
          <SubHeader>{formHeaderText}</SubHeader>
          {actionState === FormState.NEW && (
            <ConditionalContainer>
              <SingleLineInput
                label="Amount"
                value={newOrderAmount}
                onChange={(e) => {
                  setNewOrderAmount(e.currentTarget.value);
                }}
              />
              <SingleLineInput
                label="Max Amount"
                value={newOrderMaxAmount}
                onChange={(e) => {
                  setNewOrderMaxAmount(e.currentTarget.value);
                }}
              />
              <Button
                // disabled={lastAction != "new"} // TODO: add some other validation for complete text fields
                onClick={async () => {
                  setLastAction("create");
                  setActionState(FormState.NEW);
                  writeNewOrder?.();
                }}
              >
                Create
              </Button>
            </ConditionalContainer>
          )}
          {actionState === FormState.CLAIM && (
            <ConditionalContainer>
              <SingleLineInput
                label="Sender"
                value={selectedOrder.sender}
                onChange={(e) => {
                  // No-op
                }}
                readOnly={true}
              />
              <SingleLineInput
                label="Amount"
                value={selectedOrder.amount}
                onChange={(e) => {
                  // No-op
                }}
                readOnly={true}
              />
              <SingleLineInput
                label="Max Amount"
                value={selectedOrder.maxAmount}
                onChange={(e) => {
                  // No-op
                }}
                readOnly={true}
              />
              <SingleLineInput
                label="Venmo Handle"
                value={newOrderMaxAmount}
                onChange={(e) => {
                  // No-op
                }}
                readOnly={true}
              />
                <Button
                  // disabled={emailFull.trim().length === 0 || proof.length === 0}
                  onClick={async () => {
                    setLastAction("claim");
                    // write txn
                  }}
                >
                  Claim Order
                </Button>
            </ConditionalContainer>
          )}
          {actionState === FormState.UPDATE && (
            <ConditionalContainer>
              <SingleLineInput
                label="Amount"
                value={selectedOrder.amount}
                onChange={(e) => {
                  setNewOrderAmount(e.currentTarget.value);
                }}
                readOnly={true}
              />
              <SubHeader>Select Claim and Complete</SubHeader>
              <CustomTable headers={orderClaimsTableHeaders} data={orderClaimsTableData} onRowClick={handleOrderClaimRowClick}/>
              <LabeledTextArea
                label="Full Email with Headers"
                value={emailFull}
                onChange={(e) => {
                  setEmailFull(e.currentTarget.value);
                }}
              />
              <ButtonContainer>
                <Button
                  onClick={async () => {
                    setLastAction("complete");
                    writeCompleteOrder?.();
                  }}
                  style={{ marginRight: "16px" }}
                >
                  Complete Order with Proof
                </Button>
                <Button
                  onClick={async () => {
                    setLastAction("cancel");
                    // writeCancelOrder?.();
                  }}
                >
                  Cancel Order
                </Button>
              </ButtonContainer>
            </ConditionalContainer>
          )}
        </Column>
      </Main>
    </Container>
  );
};

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

const Header = styled.span`
  font-weight: 600;
  margin-bottom: 1em;
  color: #fff;
  font-size: 2.25rem;
  line-height: 2.5rem;
  letter-spacing: -0.02em;
`;

const ConditionalContainer = styled(Col)`
  width: 100%;
  gap: 1rem;
  align-self: flex-start;
`;

const SubHeader = styled(Header)`
  font-size: 1.7em;
  margin-bottom: 16px;
  color: rgba(255, 255, 255, 0.9);
`;

const Main = styled(Row)`
  width: 100%;
  gap: 1rem;
`;

const Column = styled(Col)`
  width: 100%;
  gap: 1rem;
  align-self: flex-start;
  background: rgba(255, 255, 255, 0.1);
  padding: 1.5rem;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.2);
`;

const Container = styled.div`
  display: flex;
  flex-direction: column;
  margin: 0 auto;
  & .title {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  & .main {
    & .signaturePane {
      flex: 1;
      display: flex;
      flex-direction: column;
      & > :first-child {
        height: calc(30vh + 24px);
      }
    }
  }

  & .bottom {
    display: flex;
    flex-direction: column;
    align-items: center;
    & p {
      text-align: center;
    }
    & .labeledTextAreaContainer {
      align-self: center;
      max-width: 50vw;
      width: 500px;
    }
  }
`;
